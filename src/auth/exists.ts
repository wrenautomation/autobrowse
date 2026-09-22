/**
 * Does this account already exist? Signing up blind is how you end with a
 * second account, a taken handle, and a password reset you did not mean to
 * start. Every site with a "forgot password" page answers the question the
 * same way, whatever its page says back: ask it to email the address, then
 * watch the inbox. The page is deliberately vague ("an email has been
 * sent") — the inbox is not.
 *
 * So the probe needs two things per site: where that form is, and which
 * sender counts as proof. Everything else is the same everywhere.
 */
import type { Hints } from "../browser/locate.js";
import type { Message, MessageReader } from "./codes.js";

/**
 * `exists` and `unknown-to-the-site` are answers; `cannot-tell` is the
 * honest third, for a form that refused to submit or an inbox this system
 * cannot read. Never guess between them.
 */
export type Verdict = "exists" | "unknown-to-the-site" | "cannot-tell";

export interface ResetForm {
  /** The site's "forgot password" page. */
  url: string;
  /** Where the address goes, and what sends it. */
  field: Hints;
  submit: Hints;
  /** A sender that only this site uses: mail from it is the proof. */
  from: RegExp;
  /** The same question as a mailbox search, for mail older than a poll can see. */
  query: string;
  /** How long the mail may take before silence counts as an answer. */
  waitMs?: number;
}

/** The forms we have mapped. A site that is not here can only be `cannot-tell`. */
export const RESET_FORMS: Record<string, ResetForm> = {
  npm: {
    url: "https://www.npmjs.com/forgot",
    field: { css: "#forgot_name" },
    submit: { role: "button", name: "/get password reset link/i" },
    from: /@npmjs\.(com|org)\b/i,
    query: "from:(npmjs.com OR npmjs.org)",
    waitMs: 120_000,
  },
};

export interface LookOptions {
  site: string;
  /** The address being asked about. */
  email: string;
  /** The inbox its mail lands in; the address itself unless it is an alias. */
  inbox: string;
  form: ResetForm;
  /** Fills and submits the form for this address; false when it could not. */
  ask(form: ResetForm, email: string): Promise<boolean>;
  mail: MessageReader;
  /** Every message matching the site's query, however old; absent when the inbox cannot be searched. */
  history?: (query: string) => Promise<Message[]>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface Look {
  verdict: Verdict;
  /** What was seen, in the order it was seen: the line a person reads. */
  why: string[];
}

/** One poll every this often while waiting for the site's mail. */
const POLL_MS = 10_000;

/**
 * Ask, then listen. Mail from the site inside the window means the address
 * is registered; silence through the whole window means it is not, because
 * a site that knows an address always sends.
 */
export async function lookForAccount(o: LookOptions): Promise<Look> {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const why: string[] = [];
  // Mail already there answers before anything is sent, and an account made
  // years ago is exactly the case this is for — so the whole mailbox is
  // searched, not the last few messages.
  const since = new Date(now().getTime() - 1_000);
  if (!o.history) {
    why.push(`${o.inbox} cannot be searched, so silence would prove nothing`);
    return { verdict: "cannot-tell", why };
  }
  const older = (await o.history(o.form.query).catch(() => null))?.filter((m) =>
    o.form.from.test(m.from),
  );
  if (!older) {
    why.push(`${o.inbox} refused the search, so silence would prove nothing`);
    return { verdict: "cannot-tell", why };
  }
  if (older.length) {
    const oldest = older[older.length - 1];
    why.push(
      `${o.inbox} already holds ${older.length} message(s) from ${o.site}, oldest ${oldest?.at.toISOString().slice(0, 10)}`,
    );
    return { verdict: "exists", why };
  }
  why.push(`${o.inbox} has never had mail from ${o.site}`);
  if (!(await o.ask(o.form, o.email))) {
    why.push(`the reset form at ${o.form.url} could not be submitted`);
    return { verdict: "cannot-tell", why };
  }
  why.push(`asked ${o.form.url} to send a reset link to the address`);
  const deadline = now().getTime() + (o.form.waitMs ?? 120_000);
  while (now().getTime() < deadline) {
    await sleep(POLL_MS);
    const fresh = (await o.mail.recent(o.inbox, since).catch(() => [])).filter((m) =>
      o.form.from.test(m.from),
    );
    if (fresh.length) {
      why.push(`${o.site} sent "${fresh[0]?.subject}": the address is registered`);
      return { verdict: "exists", why };
    }
  }
  why.push(`nothing arrived in ${Math.round((o.form.waitMs ?? 120_000) / 1000)}s`);
  return { verdict: "unknown-to-the-site", why };
}
