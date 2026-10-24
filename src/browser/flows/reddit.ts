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

import { already } from "../attempt.js";
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";
import { passCaptcha } from "./kit.js";
import {
  type CommentStat,
  listingFromAtom,
  num,
  type PostStat,
  type ThreadDom,
  threadFromAtom,
} from "./reddit-rss.js";

/** The little of the DOM these page scripts touch; the project compiles without lib dom. */
interface El {
  className: string;
  textContent: string | null;
  offsetParent: El | null;
  id: string;
  getAttribute(name: string): string | null;
  querySelectorAll(sel: string): Iterable<El>;
  querySelector?(sel: string): El | null;
}
declare const document: El;

export const OLD = "https://old.reddit.com";
/** Old Reddit walls a signed-out visitor at /login (2026-10-06); www answers the same `.json` signed out. */
export const WWW = "https://www.reddit.com";
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
  "author_fullname",
  "permalink",
  "url",
  "subreddit",
  "link_id",
  "link_title",
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
  "archived",
  "removed_by_category",
  "link_flair_text",
  "domain",
  "distinguished",
] as const;
/** A subreddit (t5) as `/r/{sr}/about` and `/subreddits/search` show it: who's there, what it allows, its posting notes. */
const SUBREDDIT_FIELDS = [
  "id",
  "name",
  "display_name",
  "title",
  "public_description",
  "description",
  "subscribers",
  "accounts_active",
  "active_user_count",
  "created_utc",
  "subreddit_type",
  "over18",
  "quarantine",
  "submission_type",
  "submit_text",
  "link_flair_enabled",
  "restrict_posting",
  "restrict_commenting",
  "lang",
  "url",
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
/** What a sub asks of a post (`/api/v1/{sr}/post_requirements`): title rules, flair, body and link policy. */
const POST_REQUIREMENT_FIELDS = [
  "title_regexes",
  "title_required_strings",
  "title_blacklisted_strings",
  "title_text_min_length",
  "title_text_max_length",
  "body_restriction_policy",
  "body_text_min_length",
  "body_text_max_length",
  "body_required_strings",
  "body_blacklisted_strings",
  "is_flair_required",
  "link_restriction_policy",
  "domain_blacklist",
  "domain_whitelist",
  "link_repost_age",
  "guidelines_text",
] as const;
/** A post flair a sub offers (`/r/{sr}/api/link_flair_v2`). */
const FLAIR_FIELDS = ["id", "text", "text_editable", "mod_only", "type"] as const;
/** A subreddit rule as `/r/{sr}/about/rules` lists it. */
const RULE_FIELDS = ["short_name", "description", "kind", "violation_reason", "priority"] as const;
/** Another account as `/user/{name}/about` shows it: age and karma (the warmup reads these), whether it takes messages. */
const USER_FIELDS = [
  "id",
  "name",
  "created_utc",
  "link_karma",
  "comment_karma",
  "total_karma",
  "is_suspended",
  "verified",
  "accept_pms",
  "accept_chats",
  "accept_followers",
  "icon_img",
] as const;
/** One account as `/api/user_data_by_account_ids` shows it: a card's age and karma, nothing else. */
const USER_DATA_FIELDS = [
  "name",
  "created_utc",
  "link_karma",
  "comment_karma",
  "total_karma",
  "profile_img",
  "profile_over_18",
] as const;
/** A private message (t4) or a comment reply in the inbox (t1), as the inbox listings show them. */
const MESSAGE_FIELDS = [
  "id",
  "name",
  "author",
  "dest",
  "subject",
  "body",
  "created_utc",
  "new",
  "first_message_name",
  "parent_id",
  "was_comment",
  "subreddit",
  "context",
  "distinguished",
] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const pick = (o: unknown, keys: readonly string[]): Obj => {
  const out: Obj = {};
  if (isObj(o)) for (const k of keys) if (k in o) out[k] = o[k];
  return out;
};

/** Accounts by `t2_` id, as Reddit keys them, each slimmed to its card's age and karma. */
export function slimUserData(b: unknown): Obj {
  const out: Obj = {};
  if (isObj(b))
    for (const [id, v] of Object.entries(b))
      if (/^t2_/.test(id)) out[id] = pick(v, USER_DATA_FIELDS);
  return out;
}

/** A listing with its things slimmed and its modhash dropped. */
export function slimListing(l: unknown): Obj {
  const data = isObj(l) && isObj(l.data) ? l.data : {};
  const children = Array.isArray(data.children) ? data.children : [];
  return {
    kind: "Listing",
    data: {
      after: data.after ?? null,
      before: data.before ?? null,
      children: children.filter(isObj).map((c) => ({
        kind: c.kind,
        data: pick(c.data, c.kind === "t5" ? SUBREDDIT_FIELDS : THING_FIELDS),
      })),
    },
  };
}

/** An inbox listing: messages with their reply threads, one level down. */
export function slimMessages(l: unknown): Obj {
  const data = isObj(l) && isObj(l.data) ? l.data : {};
  const children = Array.isArray(data.children) ? data.children : [];
  return {
    kind: "Listing",
    data: {
      after: data.after ?? null,
      before: data.before ?? null,
      children: children.filter(isObj).map((c) => {
        const m = pick(c.data, MESSAGE_FIELDS);
        const replies = isObj(c.data) ? c.data.replies : null;
        if (isObj(replies)) m.replies = slimMessages(replies);
        return { kind: c.kind, data: m };
      }),
    },
  };
}

const USER = "[A-Za-z0-9_-]{3,20}";
const SR = "[A-Za-z0-9_]{2,21}";
/** Several subreddits in one listing (`a+b+c`): one fetch reads them all, newest first. */
const SRS = `${SR}(?:\\+${SR})*`;

/**
 * The reads the routes send here, and how each answer is slimmed. `bare`: an API path read as
 * is, with no `.json` twin (`/api/v1/{sr}/post_requirements`).
 */
const READS: Array<{ path: RegExp; slim: (body: unknown) => unknown; bare?: boolean }> = [
  { path: /^\/api\/me$/, slim: (b) => pick(isObj(b) ? b.data : null, ME_FIELDS) },
  { path: /^\/api\/info$/, slim: slimListing },
  // `overview`: a user's posts and comments in one listing (t3 and t1 mixed, newest first).
  { path: new RegExp(`^/user/${USER}/(submitted|comments|overview)$`), slim: slimListing },
  // Up to 100 `t2_` ids a read: the cards of many accounts for the price of one.
  { path: /^\/api\/user_data_by_account_ids$/, bare: true, slim: slimUserData },
  {
    path: new RegExp(`^/user/${USER}/about$`),
    // `followers`: the profile's subscriber count, which is how many follow the account.
    slim: (b) => {
      const d = isObj(b) ? b.data : null;
      const sub = isObj(d) && isObj(d.subreddit) ? d.subreddit.subscribers : undefined;
      return { ...pick(d, USER_FIELDS), ...(typeof sub === "number" ? { followers: sub } : {}) };
    },
  },
  { path: new RegExp(`^/r/${SRS}/(new|hot|top)$`), slim: slimListing },
  { path: new RegExp(`^/r/${SR}/search$`), slim: slimListing },
  {
    path: new RegExp(`^/r/${SR}/about$`),
    slim: (b) => pick(isObj(b) ? b.data : null, SUBREDDIT_FIELDS),
  },
  { path: /^\/search$/, slim: slimListing },
  { path: /^\/subreddits\/search$/, slim: slimListing },
  { path: /^\/subreddits\/mine\/subscriber$/, slim: slimListing },
  {
    path: new RegExp(`^/api/v1/${SR}/post_requirements$`),
    bare: true,
    slim: (b) => pick(b, POST_REQUIREMENT_FIELDS),
  },
  {
    path: new RegExp(`^/r/${SR}/api/link_flair_v2$`),
    bare: true,
    slim: (b) => ({ flairs: (Array.isArray(b) ? b : []).map((f) => pick(f, FLAIR_FIELDS)) }),
  },
  { path: /^\/message\/(inbox|unread|sent)$/, slim: slimMessages },
  {
    path: /^\/comments\/[a-z0-9]{1,12}$/,
    slim: (b) => (Array.isArray(b) ? b.slice(0, 2).map(slimListing) : slimListing(b)),
  },
  {
    path: new RegExp(`^/r/${SR}/about/rules$`),
    slim: (b) => ({
      rules: (isObj(b) && Array.isArray(b.rules) ? b.rules : []).map((r) => pick(r, RULE_FIELDS)),
    }),
  },
];

/** GET the page's `.json` twin from inside the page: signed in, or signed out under `reddit-public`. */
async function fetchJson(
  fp: FlowPage,
  path: string,
  query: Record<string, string> = {},
  origin = OLD,
  bare = false,
) {
  // Signed out on www, the home page carries a "Continue with Google" sign-up rail that reads as a
  // login wall; nobody signs in there, so only the fetch's own status says whether the read worked.
  if (!fp.url().startsWith(origin))
    await fp.open(`${origin}/`, origin === WWW ? { allowWall: true } : undefined);
  // %20, not +: Reddit's search reads a + as part of the word ("agency+owners" finds nothing).
  const q = new URLSearchParams({ ...query, raw_json: "1" }).toString().replace(/\+/g, "%20");
  return fp.page.evaluate(
    async (url) => {
      const res = await fetch(url, {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      return { status: res.status, body: res.ok ? ((await res.json()) as unknown) : null };
    },
    `${origin}${path}${bare ? "" : ".json"}?${q}`,
  );
}

/** GET a page's text from inside the page (www, the session's cookies): the status and, when it answered, the body. */
async function fetchText(fp: FlowPage, url: string) {
  return fp.page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "include" });
    return { status: res.status, text: res.ok ? await res.text() : "" };
  }, url);
}

/** The signed-out reads a feed can answer, and how: a listing, or a thread (post, then comments). */
const FEEDS: Array<{
  path: RegExp;
  kind: "listing" | "thread";
  sort?: boolean;
  paged?: boolean;
  /** The path whose `/.rss` is the feed, when it is not the read's own. */
  feed?: (path: string) => string;
}> = [
  { path: new RegExp(`^/r/${SRS}/(new|hot|top)$`), kind: "listing", sort: true },
  { path: new RegExp(`^/r/${SR}/search$`), kind: "listing" },
  { path: /^\/search$/, kind: "listing" },
  { path: /^\/subreddits\/search$/, kind: "listing" },
  { path: new RegExp(`^/user/${USER}/(submitted|comments)$`), kind: "listing" },
  // A user's own feed is their overview: posts and comments together.
  {
    path: new RegExp(`^/user/${USER}/overview$`),
    kind: "listing",
    feed: (p) => p.replace(/\/overview$/, ""),
  },
  { path: /^\/api\/info$/, kind: "listing", paged: false },
  { path: /^\/comments\/[a-z0-9]{1,12}$/, kind: "thread" },
];

/** Every post on a rendered listing page, with the score and comment count it shows. */
const readPostStats = (): Array<Record<string, string | null>> =>
  [...document.querySelectorAll("shreddit-post")].map((p) => ({
    id: p.getAttribute("id"),
    score: p.getAttribute("score"),
    comments: p.getAttribute("comment-count"),
    ratio: p.getAttribute("upvote-ratio"),
  }));

/** The rendered thread: the post's numbers and each comment's place in the tree. */
const readThread = (): {
  post: Array<Record<string, string | null>>;
  comments: Array<Record<string, string | null>>;
} => ({
  post: [...document.querySelectorAll("shreddit-post")].slice(0, 1).map((p) => ({
    id: p.getAttribute("id"),
    score: p.getAttribute("score"),
    comments: p.getAttribute("comment-count"),
    ratio: p.getAttribute("upvote-ratio"),
  })),
  comments: [...document.querySelectorAll("shreddit-comment")].map((c) => ({
    id: c.getAttribute("thingid"),
    parent: c.getAttribute("parentid"),
    depth: c.getAttribute("depth"),
    score: c.getAttribute("score"),
  })),
});

const postStat = (r: Record<string, string | null> | undefined): PostStat | null =>
  r?.id ? { id: r.id, score: num(r.score), comments: num(r.comments), ratio: num(r.ratio) } : null;

/**
 * The page a feed mirrors, read for what the feed lacks. Best effort: a page that will not load
 * or render leaves those numbers out, never fails the read.
 */
async function pageNumbers<T>(fp: FlowPage, url: string, read: () => T): Promise<T | null> {
  try {
    await fp.open(url, { allowWall: true });
    return await fp.page.evaluate(read);
  } catch {
    return null;
  }
}

/**
 * Signed out, `.json` is refused (403, since about 2026-10-13) but the feed and the page answer.
 * Answers the same shape the `.json` read would, from `<path>/.rss`; the score and comment count
 * a feed lacks come from the rendered page when it shows them. Undefined: no feed serves this
 * path. A feed 404 is the read's 404 too.
 */
async function readFeed(fp: FlowPage, path: string, q: Record<string, string>) {
  const feed = FEEDS.find((f) => f.path.test(path));
  if (!feed) return undefined;
  const { raw_json: _drop, ...query } = q;
  const qs = new URLSearchParams(query).toString().replace(/\+/g, "%20");
  const got = await fetchText(fp, `${WWW}${feed.feed?.(path) ?? path}/.rss${qs ? `?${qs}` : ""}`);
  if (got.status === 404) return { error: 404, message: `no such thing: ${path}` };
  if (got.status !== 200)
    throw new Error(`reddit read ${path}: HTTP ${got.status} (feed after a 403 on .json)`);
  if (feed.kind === "thread") {
    const id = path.slice("/comments/".length);
    const raw = await pageNumbers(fp, `${WWW}/comments/${id}/`, readThread);
    const dom: ThreadDom | null = raw
      ? {
          post: postStat(raw.post[0]),
          comments: raw.comments.flatMap((c): CommentStat[] => {
            const depth = num(c.depth);
            return c.id && depth !== undefined
              ? [{ id: c.id, parent: c.parent ?? undefined, depth, score: num(c.score) }]
              : [];
          }),
        }
      : null;
    return threadFromAtom(got.text, dom);
  }
  const limit = num(query.limit);
  let stats: PostStat[] | undefined;
  if (feed.sort) {
    // /r/x/new/ renders the posts the feed lists; /top/ takes the same `t`.
    const page = `${WWW}${path}/${query.t ? `?t=${encodeURIComponent(query.t)}` : ""}`;
    const rows = await pageNumbers(fp, page, readPostStats);
    stats = rows?.flatMap((r) => postStat(r) ?? []);
  }
  return listingFromAtom(got.text, { limit, paged: feed.paged, stats });
}

export interface ReadInput {
  /** One of the READS paths, concrete: `/user/WrenAutomation/submitted`. */
  path: string;
  query?: Record<string, string | number>;
  /** Read signed out (`reddit-public`): on www, since old Reddit sends a signed-out visitor to /login. */
  signedOut?: boolean;
}

export const redditRead = defineFlow<ReadInput, unknown>({
  site: "reddit",
  name: "read",
  async run(fp, { path, query = {}, signedOut = false }) {
    const read = READS.find((r) => r.path.test(path));
    if (!read) throw new Error(`reddit read: ${path} is not a read this flow serves`);
    const q = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]));
    const got = await fetchJson(fp, path, q, signedOut ? WWW : OLD, read.bare);
    if (got.status === 404) return { error: 404, message: `no such thing: ${path}` };
    if (got.status === 403 && signedOut) {
      const viaFeed = await readFeed(fp, path, q);
      if (viaFeed !== undefined) return viaFeed;
    }
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
const RECAPTCHA = { css: 'iframe[src*="recaptcha"]' } as const;

export interface SubmitInput {
  sr: string;
  title: string;
  kind: "self" | "link" | "image";
  text?: string;
  url?: string;
  /** An image post's file, a local path by now (the route downloads a URL first). */
  image?: string;
  /** Fill everything, press nothing: the answer says what would post. */
  dry?: boolean;
  flair_id?: string;
  /** The flair as the sub shows it: old Reddit picks it on the post, after it lands. */
  flair_text?: string;
  nsfw?: boolean;
  spoiler?: boolean;
  sendreplies?: boolean;
}

/** The post page's own toggles: each asks "are you sure?" and takes "yes". */
const TOGGLES = { nsfw: "marknsfw-button", spoiler: "spoiler-button" } as const;
const MARK_MS = 5_000;

/**
 * Marks the post as old Reddit does, from its own page: NSFW, spoiler, then the flair by its
 * text. The post is up by now, so a miss is a note on the answer, never a throw (a retry would
 * post twice).
 */
async function markPost(fp: FlowPage, id: string, i: SubmitInput): Promise<string[]> {
  const thing = `#thing_t3_${id}`;
  const notes: string[] = [];
  const step = async (what: string, run: () => Promise<boolean>) => {
    try {
      if (!(await run())) notes.push(`Posted, but couldn't set ${what}: set it on the post.`);
    } catch {
      notes.push(`Posted, but couldn't set ${what}: set it on the post.`);
    }
  };
  for (const key of ["nsfw", "spoiler"] as const) {
    if (!i[key]) continue;
    await step(key === "nsfw" ? "NSFW" : "spoiler", async () => {
      const toggle: Hints = { css: `${thing} .${TOGGLES[key]} a` };
      if (!(await fp.has(toggle, MARK_MS))) return false;
      await fp.act({ kind: "click" }, toggle, { goal: `mark the post ${key}` });
      await fp.act(
        { kind: "click" },
        { css: `${thing} .${TOGGLES[key]} .yes` },
        {
          goal: `confirm ${key}`,
        },
      );
      return true;
    });
  }
  if (i.flair_text) {
    const flair = i.flair_text;
    await step(`the flair "${flair}"`, async () => {
      const open: Hints = { css: `${thing} .flairselectbtn` };
      if (!(await fp.has(open, MARK_MS))) return false;
      await fp.act({ kind: "click" }, open, { goal: "open the flair picker" });
      const pick: Hints = { css: ".flairselector li", text: flair };
      if (!(await fp.has(pick, MARK_MS))) return false;
      await fp.act({ kind: "click" }, pick, { goal: `pick the flair ${flair}` });
      await fp.act(
        { kind: "click" },
        { css: ".flairselector button[type=submit]" },
        {
          goal: "save the flair",
        },
      );
      return true;
    });
  }
  return notes;
}

/** `u_WrenAutomation` (or `u/…`): the account's own profile, the form's "Your profile" radio. */
const PROFILE_SR = /^u[_/]/i;
const POST_URL = /\/comments\/([a-z0-9]+)(\/|$)/;

/**
 * An image post on www's composer: old Reddit's form takes no image. Mapped
 * 2026-10-09 on /r/test/submit/?type=IMAGE: textbox "Title", the toolbar
 * Image button's file input (`post-composer-toolbar-button-image`, shadow
 * DOM, which CSS pierces) turns the post into an image post (button "Add images" shows),
 * textbox "Post body text field" is optional, button "Post" sends.
 */
async function submitImage(
  fp: FlowPage,
  i: SubmitInput,
): Promise<JsonAnswer<{ id: string; name: string; url: string; dry?: boolean }>> {
  if (!i.image) return refused("NO_IMAGE", "an image post needs image (a path or URL)", "image");
  if (i.flair_text || i.nsfw || i.spoiler)
    return refused("IMAGE_MARKS_UNSUPPORTED", "flair, nsfw and spoiler are not mapped on www yet");
  const me = PROFILE_SR.test(i.sr) ? await signedIn(fp) : null;
  if (PROFILE_SR.test(i.sr) && (!me || me.toLowerCase() !== i.sr.slice(2).toLowerCase()))
    return refused(
      "SUBREDDIT_NOTALLOWED",
      `only ${me || "the account"}'s own profile takes its posts`,
      "sr",
    );
  const where = PROFILE_SR.test(i.sr) ? `user/${i.sr.slice(2)}` : `r/${i.sr}`;
  await fp.open(`${WWW}/${where}/submit/?type=IMAGE`);
  const title: Hints = { role: "textbox", name: "Title" };
  if (!(await fp.has(title, RENDER_MS))) return fp.human(`reddit: no composer (${fp.url()})`);
  await fp.act({ kind: "fill", value: i.title }, title, { goal: "type the title" });
  await fp.act(
    { kind: "upload", files: [i.image] },
    { css: "post-composer-toolbar-button-image input[type=file]" },
    { goal: "add the image" },
  );
  if (!(await fp.has({ role: "button", name: "/add images/i" }, LAND_MS)))
    return fp.human("reddit: the image never showed in the composer");
  if (i.text)
    await fp.act(
      { kind: "fill", value: i.text },
      { role: "textbox", name: "Post body text field" },
      { goal: "type the body" },
    );
  const at = `${WWW}/${where}`;
  if (i.dry) return { json: { errors: [], data: { id: "", name: "", url: at, dry: true } } };
  await fp.act(
    { kind: "click" },
    { role: "button", name: "Post" },
    { goal: "post the image", irreversible: true },
  );
  // www's refusals are toasts with no codes: a person reads them.
  if (!(await fp.waitForUrl(POST_URL, LAND_MS)))
    return fp.human(`reddit: the image post did not land (${fp.url()})`);
  const id = POST_URL.exec(fp.url())?.[1] ?? "";
  return { json: { errors: [], data: { id, name: `t3_${id}`, url: fp.url() } } };
}

export const redditSubmit = defineFlow<
  SubmitInput,
  JsonAnswer<{ id: string; name: string; url: string; notes?: string[]; dry?: boolean }>
>({
  site: "reddit",
  name: "submit",
  async run(fp, i) {
    if (i.flair_id && !i.flair_text)
      return refused("FLAIR_UNSUPPORTED", "the browser leg picks a flair by its text", "flair");
    if (i.kind === "image") return submitImage(fp, i);
    if (i.dry) return refused("DRY_UNSUPPORTED", "only an image post takes dry", "dry");
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
    await passCaptcha(fp, RECAPTCHA, "reddit: the form's captcha");
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
      const url = fp.url().replace(OLD, "https://www.reddit.com");
      const notes = await markPost(fp, id, i);
      return {
        json: {
          errors: [],
          data: { id, name: `t3_${id}`, url, ...(notes.length ? { notes } : {}) },
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
    await passCaptcha(fp, RECAPTCHA, "reddit: the form's captcha");
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

export interface MessageInput {
  /** The recipient's username, without u/. */
  to: string;
  subject: string;
  text: string;
}

/**
 * A private message through old Reddit's compose form
 * (`/message/compose/?to=<name>`: `input[name=to]`, `input[name=subject]`,
 * `textarea[name=text]`, a reCAPTCHA for a new account, `button#send`). A
 * delivered message leaves "your message has been delivered" in the form's
 * `.status`; a refused one a `span.error.<CODE>.field-<field>`
 * (USER_DOESNT_EXIST, NOT_WHITELISTED_BY_USER_MESSAGE when the person takes
 * no messages, RATELIMIT). The route caps these per account per day: a new
 * account that messages strangers fast is the one Reddit shadowbans.
 */
export const redditMessage = defineFlow<MessageInput, JsonAnswer<{ delivered: true }>>({
  site: "reddit",
  name: "message",
  async run(fp, { to, subject, text }) {
    const name = to.replace(/^\/?u\//i, "");
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(name))
      return refused("BAD_USER", `${to} is not a Reddit username`, "to");
    await fp.open(`${OLD}/message/compose/?to=${encodeURIComponent(name)}`);
    const form = "#compose-message";
    const toBox: Hints = { css: `${form} input[name=to]` };
    if (!(await fp.has(toBox, RENDER_MS))) return fp.human(`reddit: no compose form (${fp.url()})`);
    const me = await signedIn(fp);
    if (me && me.toLowerCase() === name.toLowerCase())
      return refused("BAD_USER", "the account cannot message itself", "to");
    await fp.act({ kind: "fill", value: name }, toBox, { goal: "name the recipient" });
    await fp.act(
      { kind: "fill", value: subject },
      { css: `${form} input[name=subject]` },
      {
        goal: "type the subject",
      },
    );
    await fp.act(
      { kind: "fill", value: text },
      { css: `${form} textarea[name=text]` },
      {
        goal: "type the message",
      },
    );
    await passCaptcha(fp, RECAPTCHA, "reddit: the form's captcha");
    await fp.act(
      { kind: "click" },
      { css: `${form} button#send, ${form} button[type=submit]` },
      {
        goal: `send the message to ${name}`,
        irreversible: true,
      },
    );
    for (let waited = 0; waited < LAND_MS; waited += 1_000) {
      const status = await fp.page.evaluate(
        (sel) =>
          [...document.querySelectorAll(`${sel} .status`)]
            .map((e) => (e.textContent ?? "").trim())
            .find(Boolean) ?? "",
        form,
      );
      if (/delivered/i.test(status)) return { json: { errors: [], data: { delivered: true } } };
      const errors = await formErrors(fp, form);
      if (errors.length) return { json: { errors } };
      await fp.wait(1_000);
    }
    return fp.human(`reddit: the message neither said delivered nor why not (${fp.url()})`);
  },
});

export interface SubscribeInput {
  /** The subreddit, without r/. */
  sr_name: string;
  /** `sub` joins, `unsub` leaves. */
  action: "sub" | "unsub";
  /** Read the sub's state, press nothing. */
  dry?: boolean;
}

/** Old Reddit's join toggle in the sidebar: the visible half is `.active` (`add` = join, `remove` = leave). */
const JOINED: Hints = { css: ".side .subscribe-button .remove.active" };
const JOIN: Hints = { css: ".side .subscribe-button .add.active" };
const LEAVE: Hints = { css: ".side .subscribe-button .remove.active" };

/**
 * Join (or leave) a subreddit with the sidebar's toggle on old Reddit, as a person does. Mapped
 * 2026-10-15: `/r/<sr>/` shows `span.subscribe-button` with two `a.option`s, the active one the
 * button a visitor sees. Already in that state answers without a press; `dry` only reads it.
 * Answers `{json:{errors,data:{subscribed, changed, dry?}}}`.
 */
export const redditSubscribe = defineFlow<
  SubscribeInput,
  JsonAnswer<{ subscribed: boolean; changed: boolean; dry?: boolean }>
>({
  site: "reddit",
  name: "subscribe",
  async run(fp, { sr_name, action, dry = false }) {
    const sr = sr_name.replace(/^\/?r\//i, "");
    if (!/^[A-Za-z0-9_]{2,21}$/.test(sr))
      return refused("BAD_SR_NAME", `${sr_name} is not a subreddit`, "sr_name");
    await fp.open(`${OLD}/r/${sr}/`);
    const toggle: Hints = { css: ".side .subscribe-button .option.active" };
    if (!(await fp.has(toggle, RENDER_MS))) {
      if (/\/subreddits\/search|\/login/.test(fp.url()))
        return refused("SUBREDDIT_NOEXIST", `no r/${sr} on Reddit`, "sr_name");
      return fp.human(`reddit: no join button on r/${sr} (${fp.url()})`);
    }
    if (!(await signedIn(fp))) return fp.human("reddit: signed out on this profile");
    const joined = await fp.has(JOINED, 1_000);
    const want = action === "sub";
    if (dry) return { json: { errors: [], data: { subscribed: joined, changed: false, dry } } };
    if (joined === want)
      return already({ json: { errors: [], data: { subscribed: joined, changed: false } } });
    await fp.act({ kind: "click" }, want ? JOIN : LEAVE, {
      goal: `${want ? "join" : "leave"} r/${sr}`,
      irreversible: true,
    });
    if (await fp.has(want ? JOINED : JOIN, LAND_MS))
      return { json: { errors: [], data: { subscribed: want, changed: true } } };
    return fp.human(
      `reddit: pressed ${want ? "join" : "leave"} on r/${sr}, the button never turned`,
    );
  },
});
