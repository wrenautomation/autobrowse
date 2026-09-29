/**
 * Reddit through the signed-in old.reddit.com page, in the Data API's own
 * shapes: Reddit refused Wren an API client (2026-09-29), and the page does
 * the same things for a signed-in account.
 *
 * Reads fetch the site's `.json` twin of a page from inside the page (same
 * origin, the session's cookies), then keep only what a caller reads: the
 * modhash (the session's CSRF token) never leaves the browser.
 *
 * Writes use the forms, as a person does. Mapped 2026-09-29 in explore as
 * reddit@wren: `/submit?selftext=true` is the text form (`textarea[name=title]`,
 * `textarea[name=text]`, `input[name=sr]`, a "Your profile" radio, a
 * reCAPTCHA for a new account, button "submit"); a link post fills `#url`
 * instead. A refused submit stays on the page with a visible
 * `span.error.<CODE>.field-<field>` ("Hmm, that community doesn't exist");
 * an accepted one lands on `/comments/<id>/`. A comment's reply link is
 * `#thing_t1_<id> > .entry a[onclick*=reply]`, which clones a
 * `form.usertext` into the thing's `.child`; a post's own form is
 * `.commentarea > form.usertext`. Both save with `button[type=submit]`.
 */
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";

/** The little of the DOM these page scripts touch; the project compiles without lib dom. */
interface El {
  className: string;
  textContent: string | null;
  offsetParent: El | null;
  id: string;
  getAttribute(name: string): string | null;
  querySelectorAll(sel: string): Iterable<El>;
}
declare const document: El;

export const OLD = "https://old.reddit.com";
const RENDER_MS = 15_000;
const LAND_MS = 30_000;

/** Reddit's `api_type=json` envelope: errors are `[code, message, field]`. */
export interface JsonAnswer<T> {
  json: { errors: Array<[string, string, string]>; data?: T };
}
const refused = (code: string, message: string, field = ""): JsonAnswer<never> => ({
  json: { errors: [[code, message, field]] },
});

/** What a caller reads of a post or comment; everything else stays on the page. */
const THING_FIELDS = [
  "id",
  "name",
  "title",
  "selftext",
  "body",
  "author",
  "permalink",
  "url",
  "subreddit",
  "link_id",
  "parent_id",
  "created_utc",
  "score",
  "upvote_ratio",
  "num_comments",
  "num_crossposts",
  "view_count",
  "is_self",
  "over_18",
  "locked",
  "stickied",
  "removed_by_category",
] as const;
/** The account as `/api/v1/me` answers it, minus the session's secrets. */
const ME_FIELDS = [
  "id",
  "name",
  "created_utc",
  "link_karma",
  "comment_karma",
  "total_karma",
  "has_verified_email",
  "is_suspended",
  "icon_img",
] as const;
/** A subreddit rule as `/r/{sr}/about/rules` lists it. */
const RULE_FIELDS = ["short_name", "description", "kind", "violation_reason", "priority"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const pick = (o: unknown, keys: readonly string[]): Obj => {
  const out: Obj = {};
  if (isObj(o)) for (const k of keys) if (k in o) out[k] = o[k];
  return out;
};

/** A listing with its things slimmed and its modhash dropped. */
export function slimListing(l: unknown): Obj {
  const data = isObj(l) && isObj(l.data) ? l.data : {};
  const children = Array.isArray(data.children) ? data.children : [];
  return {
    kind: "Listing",
    data: {
      after: data.after ?? null,
      before: data.before ?? null,
      children: children
        .filter(isObj)
        .map((c) => ({ kind: c.kind, data: pick(c.data, THING_FIELDS) })),
    },
  };
}

/** The reads the routes send here, and how each answer is slimmed. */
const READS: Array<{ path: RegExp; slim: (body: unknown) => unknown }> = [
  { path: /^\/api\/me$/, slim: (b) => pick(isObj(b) ? b.data : null, ME_FIELDS) },
  { path: /^\/api\/info$/, slim: slimListing },
  { path: /^\/user\/[A-Za-z0-9_-]{3,20}\/(submitted|comments)$/, slim: slimListing },
  {
    path: /^\/comments\/[a-z0-9]{1,12}$/,
    slim: (b) => (Array.isArray(b) ? b.slice(0, 2).map(slimListing) : slimListing(b)),
  },
  {
    path: /^\/r\/[A-Za-z0-9_]{2,21}\/about\/rules$/,
    slim: (b) => ({
      rules: (isObj(b) && Array.isArray(b.rules) ? b.rules : []).map((r) => pick(r, RULE_FIELDS)),
    }),
  },
];

/** GET the page's `.json` twin from inside the signed-in page. */
async function fetchJson(fp: FlowPage, path: string, query: Record<string, string> = {}) {
  if (!fp.url().startsWith(OLD)) await fp.open(`${OLD}/`);
  const q = new URLSearchParams({ ...query, raw_json: "1" }).toString();
  return fp.page.evaluate(async (url) => {
    const res = await fetch(url, {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    return { status: res.status, body: res.ok ? ((await res.json()) as unknown) : null };
  }, `${OLD}${path}.json?${q}`);
}

export interface ReadInput {
  /** One of the READS paths, concrete: `/user/WrenAutomation/submitted`. */
  path: string;
  query?: Record<string, string | number>;
}

export const redditRead = defineFlow<ReadInput, unknown>({
  site: "reddit",
  name: "read",
  async run(fp, { path, query = {} }) {
    const read = READS.find((r) => r.path.test(path));
    if (!read) throw new Error(`reddit read: ${path} is not a read this flow serves`);
    const q = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]));
    const got = await fetchJson(fp, path, q);
    if (got.status === 404) return { error: 404, message: `no such thing: ${path}` };
    if (got.status !== 200) throw new Error(`reddit read ${path}: HTTP ${got.status}`);
    const out = read.slim(got.body);
    if (path === "/api/me" && !(out as Obj).name)
      return fp.human(
        "Reddit is signed out on this profile: `autobrowse login reddit@wren --headed`",
      );
    return out;
  },
});

/** The visible errors a refused form shows, as Reddit's `[code, message, field]` triples. */
async function formErrors(fp: FlowPage, scope: string): Promise<Array<[string, string, string]>> {
  return fp.page.evaluate(
    (sel) =>
      [...document.querySelectorAll(`${sel} .error`)]
        .filter((e) => e.offsetParent !== null && (e.textContent ?? "").trim() !== "")
        .map((e) => {
          const cls = e.className.split(/\s+/).filter(Boolean);
          const code = cls.find((c) => c !== "error" && !c.startsWith("field-")) ?? "REFUSED";
          const field = (cls.find((c) => c.startsWith("field-")) ?? "").replace(/^field-/, "");
          return [code, (e.textContent ?? "").trim(), field] as [string, string, string];
        }),
    scope,
  );
}

/** A new account's forms carry a reCAPTCHA: solved last, just before the irreversible click. */
async function passCaptcha(fp: FlowPage) {
  if (!(await fp.has({ css: 'iframe[src*="recaptcha"]' }, 2_000))) return;
  const got = await fp.captcha();
  if (!got.solved) fp.human(`reddit: the form's captcha is a person's (${got.reason})`);
}

export interface SubmitInput {
  sr: string;
  title: string;
  kind: "self" | "link";
  text?: string;
  url?: string;
  flair_id?: string;
  sendreplies?: boolean;
}

/** `u_WrenAutomation` (or `u/…`): the account's own profile, the form's "Your profile" radio. */
const PROFILE_SR = /^u[_/]/i;
const POST_URL = /\/comments\/([a-z0-9]+)(\/|$)/;

export const redditSubmit = defineFlow<
  SubmitInput,
  JsonAnswer<{ id: string; name: string; url: string }>
>({
  site: "reddit",
  name: "submit",
  async run(fp, i) {
    if (i.flair_id)
      return refused("FLAIR_UNSUPPORTED", "the browser leg cannot pick a flair yet", "flair");
    await fp.open(`${OLD}/submit${i.kind === "self" ? "?selftext=true" : ""}`);
    const title: Hints = { css: "textarea[name=title]" };
    if (!(await fp.has(title, RENDER_MS))) return fp.human(`reddit: no submit form (${fp.url()})`);
    if (i.kind === "link")
      await fp.act(
        { kind: "fill", value: i.url ?? "" },
        { css: "#url" },
        { goal: "type the link" },
      );
    await fp.act({ kind: "fill", value: i.title }, title, { goal: "type the title" });
    if (i.kind === "self" && i.text)
      await fp.act(
        { kind: "fill", value: i.text },
        { css: "textarea[name=text]" },
        { goal: "type the body" },
      );
    if (PROFILE_SR.test(i.sr)) {
      // "Your profile" is the signed-in account's own: never a post meant for someone else's.
      const me = await signedIn(fp);
      if (!me || me.toLowerCase() !== i.sr.slice(2).toLowerCase())
        return refused(
          "SUBREDDIT_NOTALLOWED",
          `only ${me || "the account"}'s own profile takes its posts`,
          "sr",
        );
      await fp.act(
        { kind: "click" },
        { role: "radio", name: "Your profile" },
        { goal: "post to the profile" },
      );
    } else {
      const sr: Hints = { css: "input[name=sr]" };
      await fp.act({ kind: "fill", value: i.sr }, sr, { goal: "name the subreddit" });
      // Typing opens a suggestion list over the captcha, its first row highlighted: close it.
      await fp.act({ kind: "press", key: "Escape" }, sr, { goal: "close the suggestions" });
    }
    if (i.sendreplies === false)
      await fp.act(
        { kind: "click" },
        { role: "checkbox", name: "send replies to my inbox" },
        { goal: "no replies to the inbox" },
      );
    await passCaptcha(fp);
    // A suggestion taken by mistake posts somewhere else: the field must still say what was asked.
    if (!PROFILE_SR.test(i.sr)) {
      const typed = await fp.page.locator("input[name=sr]").inputValue();
      if (typed.toLowerCase() !== i.sr.toLowerCase())
        return fp.human(`reddit: the subreddit field says "${typed}", not "${i.sr}"`);
    }
    await fp.act(
      { kind: "click" },
      // The header search's unlabeled submit input is also named "Submit": pin the post form.
      { css: "#newlink button[name=submit]" },
      {
        goal: "submit the post",
        irreversible: true,
      },
    );
    if (await fp.waitForUrl(POST_URL, LAND_MS)) {
      const id = POST_URL.exec(fp.url())?.[1] ?? "";
      return {
        json: {
          errors: [],
          data: { id, name: `t3_${id}`, url: fp.url().replace(OLD, "https://www.reddit.com") },
        },
      };
    }
    const errors = await formErrors(fp, "form");
    if (errors.length) return { json: { errors } };
    return fp.human(`reddit: the submit neither landed on the post nor said why (${fp.url()})`);
  },
});

export interface CommentInput {
  /** `t3_<post>` for a top-level comment, `t1_<comment>` for a reply. */
  thing_id: string;
  text: string;
}

export const redditComment = defineFlow<CommentInput, JsonAnswer<{ things: unknown[] }>>({
  site: "reddit",
  name: "comment",
  async run(fp, { thing_id, text }) {
    if (!/^t[13]_[a-z0-9]+$/.test(thing_id))
      return refused("BAD_ID", `${thing_id} is not a t1_ or t3_ id`, "thing_id");
    const info = await fetchJson(fp, "/api/info", { id: thing_id });
    const thing = slimListing(info.body) as { data: { children: Array<{ data: Obj }> } };
    const permalink = thing.data.children[0]?.data.permalink;
    if (typeof permalink !== "string")
      return refused("NO_THING", `no ${thing_id} on Reddit`, "thing_id");
    await fp.open(`${OLD}${permalink}`);
    const isReply = thing_id.startsWith("t1_");
    const scope = isReply ? `#thing_${thing_id} > .child` : ".commentarea > form.usertext";
    if (isReply) {
      const reply: Hints = { css: `#thing_${thing_id} > .entry a[onclick*=reply]` };
      if (!(await fp.has(reply, RENDER_MS)))
        return refused(
          "NO_REPLY",
          "the comment takes no replies (archived, locked, or removed)",
          "thing_id",
        );
      await fp.act({ kind: "click" }, reply, { goal: "open the reply box" });
    } else if (!(await fp.has({ css: `${scope} textarea[name=text]` }, RENDER_MS))) {
      return refused("NO_REPLY", "the post takes no comments (archived or locked)", "thing_id");
    }
    const before = await mine(fp);
    await fp.act(
      { kind: "fill", value: text },
      { css: `${scope} textarea[name=text]` },
      { goal: "type the comment" },
    );
    await passCaptcha(fp);
    await fp.act(
      { kind: "click" },
      { css: `${scope} button[type=submit]` },
      {
        goal: "save the comment",
        irreversible: true,
      },
    );
    for (let waited = 0; waited < LAND_MS; waited += 1_000) {
      const now = await mine(fp);
      const made = now.find((id) => !before.includes(id));
      if (made)
        return {
          json: {
            errors: [],
            data: { things: [{ kind: "t1", data: { id: made.replace(/^t1_/, ""), name: made } }] },
          },
        };
      const errors = await formErrors(fp, scope);
      if (errors.length) return { json: { errors } };
      await fp.wait(1_000);
    }
    return fp.human(`reddit: the comment neither showed up nor said why (${fp.url()})`);
  },
});

/** The fullnames of the comments on the page by the signed-in account. */
/** The signed-in account's name from old Reddit's header; "" when signed out. */
function signedIn(fp: FlowPage): Promise<string> {
  return fp.page.evaluate(
    () => [...document.querySelectorAll("#header .user a")][0]?.textContent?.trim() ?? "",
  );
}

function mine(fp: FlowPage): Promise<string[]> {
  return fp.page.evaluate(() => {
    const me = [...document.querySelectorAll("#header .user a")][0]?.textContent ?? "";
    return [...document.querySelectorAll(".thing.comment")]
      .filter((c) => me !== "" && c.getAttribute("data-author") === me)
      .map((c) => c.getAttribute("data-fullname") ?? c.id.replace(/^thing_/, ""));
  });
}
