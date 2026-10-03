/**
 * Give a sending inbox ordinary mail of its own: subscribe it to a few free
 * newsletters through their own subscribe page in the browser, then open
 * the confirm link any of them mails, and the verify links of the free
 * accounts `autobrowse inbox-accounts <inbox>` made (FREE_ACCOUNTS).
 * Substack's subscribe API answers 200 to a bare POST and then sends
 * nothing (2026-10-02), so the page is the way in. Mail is read through the
 * Gmail client (delegation for our Workspace). A rerun skips what it did.
 */
import { z } from "zod";
import { FREE_ACCOUNT_SENDERS } from "../../auth/free-accounts.js";
import { defineFlow } from "../../browser/flow.js";
import type { HttpClient } from "../../clients/http.js";
import { defineWorkflow, done, type StepDef } from "../../engine/workflow.js";
import type { DomainDeps } from "../domain/deps.js";

/** Free Substack newsletters a founder selling to small firms would read. */
export const NEWSLETTERS = [
  "https://www.lennysnewsletter.com",
  "https://www.notboring.co",
  "https://newsletter.pragmaticengineer.com",
  "https://www.oneusefulthing.org",
  "https://www.latent.space",
  "https://www.exponentialview.co",
];

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const RENDER_MS = 15_000;

export const inboxActivityPlanSchema = z.object({
  inbox: z.string().email().describe("The sending inbox that gets the mail"),
  newsletters: z
    .array(z.string().url())
    .min(1)
    .default(NEWSLETTERS)
    .describe("Substack publications, by their home URL"),
  senders: z
    .array(z.string())
    .default([...FREE_ACCOUNT_SENDERS])
    .describe(
      "Hosts of free accounts made for this inbox (todoist.com): their verify mail is opened too",
    ),
  /** How long to wait for confirm mail before calling it done. */
  confirmWaitMinutes: z.number().int().min(0).default(10),
  dryRun: z.boolean().default(false),
});

export type InboxActivityPlan = z.infer<typeof inboxActivityPlanSchema>;
export type InboxActivityDeps = Pick<DomainDeps, "gmail" | "browser"> & { http: HttpClient };
export interface InboxActivityMemo {
  /** When the first subscribe went out: confirm mail is looked for after it. */
  since?: string;
  subscribed?: string[];
  confirmed?: string[];
}

export interface SubscribeInput {
  home: string;
  email: string;
}

/** The publication's /subscribe page: Email, then Subscribe. The upsell screens after it are left. */
export const subscribeFlow = defineFlow<SubscribeInput, { subscribed: boolean; note: string }>({
  site: "newsletters",
  name: "substack-subscribe",
  async run(fp, input) {
    await fp.open(`${input.home.replace(/\/$/, "")}/subscribe`);
    const email = { role: "textbox" as const, name: "/email/i" };
    if (!(await fp.has(email, RENDER_MS)))
      return { subscribed: false, note: `no email field at ${fp.url()}` };
    await fp.act({ kind: "fill", value: input.email }, email, { goal: "type the address" });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^subscribe/i" },
      { goal: "subscribe free", irreversible: true },
    );
    await fp.wait(4_000);
    const check = await fp.captcha();
    if (!check.solved && check.kind)
      return { subscribed: false, note: `a ${check.kind} bot check at ${fp.url()}` };
    const page = (await fp.text()).toLowerCase();
    const stuck =
      (await fp.has(email, 1_000)) && !/check your|subscribed|welcome|thanks for/.test(page);
    return stuck
      ? { subscribed: false, note: `still on the form at ${fp.url()}` }
      : { subscribed: true, note: new URL(fp.url()).pathname };
  },
});

type Step = StepDef<InboxActivityPlan, InboxActivityDeps, InboxActivityMemo>;

const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, "");

const CONFIRMS = /confirm|verify|activate|opt-?in/i;

/**
 * Links in a mail that confirm a subscription or an address: by the URL, or
 * by the button text right after it (Substack's are tracked redirects).
 */
export function confirmLinks(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/https:\/\/[^\s"'<>)\]]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    const label =
      text
        .slice((m.index ?? 0) + m[0].length)
        .split(/https:\/\//)[0]
        ?.slice(0, 40) ?? "";
    if (CONFIRMS.test(url) || CONFIRMS.test(label)) found.push(url);
  }
  return [...new Set(found)];
}

export const subscribe: Step = {
  name: "subscribe",
  irreversible: true,
  async run({ fx, deps, plan, memo }) {
    memo.since ??= (await fx.now()).toISOString();
    const ok: string[] = [];
    const failed: string[] = [];
    for (const home of plan.newsletters) {
      const host = hostOf(home);
      const r = await fx.run(`subscribe ${host}`, () =>
        deps.browser.run(subscribeFlow, { home, email: plan.inbox }),
      );
      if (r.subscribed) ok.push(host);
      else failed.push(`${host} (${r.note})`);
    }
    memo.subscribed = ok;
    if (!ok.length) throw new Error(`no newsletter took ${plan.inbox}: ${failed.join(", ")}`);
    return done(
      `${plan.inbox} on ${ok.join(", ")}${failed.length ? `; not taken: ${failed.join(", ")}` : ""}`,
    );
  },
};

export const confirm: Step = {
  name: "confirm",
  async run({ fx, deps, plan, memo }) {
    const since = new Date(memo.since ?? (await fx.now()).toISOString());
    const subscribed = memo.subscribed ?? [];
    const watched = [...subscribed, ...plan.senders.map((h) => h.replace(/^www\./, ""))];
    const confirmed = new Set(memo.confirmed ?? []);
    const deadline = since.getTime() + plan.confirmWaitMinutes * 60_000;
    let heard = 0;
    for (let round = 0; ; round++) {
      const mail = await fx.run(`read ${round}`, async () =>
        (await deps.gmail.recent(plan.inbox, since)).map((m) => ({ from: m.from, text: m.text })),
      );
      const theirs = mail.filter((m) =>
        watched.some((h) => m.from.toLowerCase().includes(h) || m.text.includes(h)),
      );
      heard = subscribed.filter((h) =>
        theirs.some((m) => m.from.toLowerCase().includes(h) || m.text.includes(h)),
      ).length;
      for (const m of theirs)
        for (const link of confirmLinks(m.text)) {
          if (confirmed.has(link)) continue;
          const status = await fx.run(`open ${link}`, async () => {
            const res = await deps.http.json(link, { headers: { "user-agent": BROWSER_UA } });
            return res.status;
          });
          if (status < 400) confirmed.add(link);
        }
      memo.confirmed = [...confirmed];
      if (heard >= subscribed.length || (await fx.now()).getTime() >= deadline) break;
      await fx.sleep(30_000);
    }
    return done(
      `${heard} of ${subscribed.length} newsletters mailed; ${confirmed.size} confirm links opened`,
    );
  },
};

export const inboxActivityWorkflow = defineWorkflow<InboxActivityDeps, InboxActivityMemo>()({
  name: "inbox-activity",
  description:
    "subscribe a sending inbox to free newsletters and open the confirm links it gets (newsletters, free accounts)",
  plan: inboxActivityPlanSchema,
  steps: [subscribe, confirm],
  emptyMemo: () => ({}),
});

export type InboxActivityWorkflow = typeof inboxActivityWorkflow;
