/**
 * Search, reply, like and follow on Threads as the signed-in account. Threads signs in through
 * Instagram, so these run on the instagram profile. The API's keyword search finds only our own
 * posts until Meta reviews `threads_keyword_search`, and a reply by the API needs a Graph id
 * the web's post codes do not give, so all four go through the page.
 *
 * Search (`/search?q=&filter=recent`) lists posts as `[data-pressable-container]` cards: an
 * `/@<user>` link, a `/@<user>/post/<code>` link with a `time[datetime]`, the text, and the
 * Like, Reply, Repost and Share buttons, each named by its icon's `title` (a zero count is blank). A post page's first card is the post; its
 * buttons are named "Like N" (then "Unlike N") and "Reply N". Reply opens a dialog with one
 * contenteditable box and a Post button. A profile's button reads Follow, then Following.
 *
 * Mapped 2026-10-26 in explore (the reply dialog opened and was cancelled; nothing was sent).
 */
import { already } from "../attempt.js";
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";
import { RENDER_MS, SETTLE_MS } from "./kit.js";

const WEB = "https://www.threads.com";
const SCROLLS = 6;
export const MAX_THREADS_SEARCH = 60;
const MISSING = /sorry, this page isn.t available|this post is unavailable|post isn.t available/i;

async function openThreads(fp: FlowPage, url: string): Promise<void> {
  await fp.open(url);
  if (/\/login\b/.test(fp.url()))
    fp.human("Threads is signed out on this profile: `autobrowse login instagram`");
}

export interface ThreadsPost {
  code: string;
  url: string;
  username: string;
  text: string;
  at: string;
  likes: number | null;
  replies: number | null;
}

/** "1.2K" reads 1200; "" or words read null. */
export function countOf(s: string | undefined): number | null {
  const m = /^([\d.,]+)\s*([KM])?$/i.exec((s ?? "").trim());
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, ""));
  const k = m[2]?.toUpperCase();
  return Math.round(n * (k === "K" ? 1_000 : k === "M" ? 1_000_000 : 1));
}

/** Each card as plain fields; a reply ("Replying to @x") is left, so is a card with no post link. */
const CARDS = `(() => [...document.querySelectorAll("[data-pressable-container]")].map((c) => {
  const post = [...c.querySelectorAll("a[href*='/post/']")].map((a) => a.getAttribute("href")).find(Boolean) ?? "";
  const spans = [...c.querySelectorAll("span[dir=auto]")].map((s) => s.innerText.trim());
  const counts = Object.fromEntries([...c.querySelectorAll("[role=button]")].map((b) => [b.querySelector("title")?.textContent ?? "", b.innerText.trim()]));
  return { post, at: c.querySelector("time")?.getAttribute("datetime") ?? "", spans, counts, text: c.innerText };
}))()`;

interface Card {
  post: string;
  at: string;
  spans: string[];
  /** Each button's count by its icon's title (Like, Reply); "" for zero. */
  counts: Record<string, string>;
  text: string;
}

/** A card as a post: the spans past the name and the time, less the counts and carousel marks. */
export function postOfCard(c: Card): ThreadsPost | null {
  const m = /^\/@([\w.]{1,40})\/post\/([\w-]+)/.exec(c.post);
  if (!m?.[1] || !m[2] || /\bReplying to @/i.test(c.text)) return null;
  const [, username, code] = m;
  const body = c.spans
    .slice(2)
    .filter((s) => !/^[\d.,]+[KM]?$/i.test(s))
    .join("\n")
    .split("\n")
    .filter((l) => !/^(\d+|\/)$/.test(l.trim()))
    .join("\n")
    .trim();
  return {
    code,
    url: `${WEB}/@${username}/post/${code}`,
    username,
    text: body,
    at: c.at,
    likes: countOf(c.counts.Like || c.counts.Unlike || "0"),
    replies: countOf(c.counts.Reply || "0"),
  };
}

export const threadsSearch = defineFlow<
  { q: string; max?: number },
  { q: string; data: ThreadsPost[] }
>({
  site: "instagram",
  name: "threads-search",
  async run(fp, { q, max }) {
    const cap = Math.min(Math.max(1, max ?? 30), MAX_THREADS_SEARCH);
    await openThreads(
      fp,
      `${WEB}/search?q=${encodeURIComponent(q)}&serp_type=default&filter=recent`,
    );
    const seen = new Map<string, ThreadsPost>();
    const take = async () => {
      for (const c of await fp.page.evaluate<Card[]>(CARDS).catch(() => [] as Card[])) {
        const p = postOfCard(c);
        if (p && !seen.has(p.code)) seen.set(p.code, p);
      }
    };
    for (let i = 0; i < RENDER_MS / SETTLE_MS && !seen.size; i++) {
      await take();
      if (!seen.size) await fp.wait(SETTLE_MS);
    }
    let still = 0;
    for (let i = 0; i < SCROLLS && seen.size < cap && still < 2; i++) {
      const before = seen.size;
      await fp.scroll(2_000);
      await fp.wait(SETTLE_MS * 2);
      await take();
      still = seen.size > before ? 0 : still + 1;
    }
    return { q, data: [...seen.values()].slice(0, cap) };
  },
});

const postUrl = (username: string, code: string) =>
  `${WEB}/@${encodeURIComponent(username)}/post/${encodeURIComponent(code)}`;

async function shown(fp: FlowPage, what: Hints[]): Promise<number | "missing" | null> {
  for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
    for (const [n, h] of what.entries()) if (await fp.has(h)) return n;
    if (MISSING.test(await fp.text())) return "missing";
    await fp.wait(SETTLE_MS);
  }
  return null;
}

export interface ThreadsPostInput {
  username: string;
  code: string;
}

const like: Hints = { role: "button", name: "/^Like( [\\d.,]+[KM]?)?$/" };
const liked: Hints = { role: "button", name: "/^Unlike( [\\d.,]+[KM]?)?$/" };

export const threadsLike = defineFlow<
  ThreadsPostInput,
  { code: string; liked: true; already?: true } | { found: false; reason: string }
>({
  site: "instagram",
  name: "threads-like",
  async run(fp, { username, code }) {
    await openThreads(fp, postUrl(username, code));
    const state = await shown(fp, [liked, like]);
    if (state === "missing") return { found: false, reason: `no Threads post ${code}` };
    if (state === null) return fp.human(`no Like on Threads post ${code} (${fp.url()})`);
    if (state === 0) return already({ code, liked: true, already: true });
    await fp.act({ kind: "click" }, like, { goal: `like Threads post ${code}` });
    if (!(await fp.has(liked, RENDER_MS)))
      return fp.human(`Threads did not take the like on ${code}`);
    return { code, liked: true };
  },
});

const replyButton: Hints = { role: "button", name: "/^Reply( [\\d.,]+[KM]?)?$/" };
const replyBox: Hints = { css: '[role="dialog"] [contenteditable="true"]' };
const postButton: Hints = { role: "button", name: "/^Post$/" };
const dialog: Hints = { css: '[role="dialog"]' };

export const threadsReply = defineFlow<
  ThreadsPostInput & { text: string },
  { code: string; replied: true } | { found: false; reason: string }
>({
  site: "instagram",
  name: "threads-reply",
  async run(fp, { username, code, text }) {
    await openThreads(fp, postUrl(username, code));
    const state = await shown(fp, [replyButton]);
    if (state === "missing") return { found: false, reason: `no Threads post ${code}` };
    if (state === null) return fp.human(`no Reply on Threads post ${code} (${fp.url()})`);
    // The post's own Reply is the first; the replies under it carry theirs.
    await fp.act({ kind: "click" }, replyButton, { goal: `open a reply to ${code}` });
    if (!(await fp.has(replyBox, RENDER_MS)))
      return fp.human(`the reply box did not open on ${code}: replies may be limited`);
    await fp.act({ kind: "fill", value: text }, replyBox, { goal: "type the reply" });
    await fp.wait(SETTLE_MS);
    await fp.act({ kind: "click" }, postButton, {
      goal: `reply to Threads post ${code}`,
      irreversible: true,
    });
    // The dialog closes once Threads takes the reply.
    for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
      await fp.wait(SETTLE_MS);
      if (!(await fp.has(dialog))) return { code, replied: true };
    }
    return fp.human(`the reply dialog stayed open on ${code}: Threads may not have taken it`);
  },
});

const followButton: Hints = { role: "button", name: "/^Follow( back)?$/" };
const following: Hints = { role: "button", name: "/^Following$/" };

export const threadsFollow = defineFlow<
  { username: string },
  { username: string; following: true; already?: true } | { found: false; reason: string }
>({
  site: "instagram",
  name: "threads-follow",
  async run(fp, { username }) {
    const handle = username.replace(/^@/, "");
    await openThreads(fp, `${WEB}/@${encodeURIComponent(handle)}`);
    const state = await shown(fp, [following, followButton]);
    if (state === "missing") return { found: false, reason: `no Threads account @${handle}` };
    if (state === null) return fp.human(`no Follow on @${handle} (${fp.url()})`);
    if (state === 0) return already({ username: handle, following: true, already: true });
    await fp.act({ kind: "click" }, followButton, { goal: `follow @${handle} on Threads` });
    if (!(await fp.has(following, RENDER_MS)))
      return fp.human(`Threads did not take the follow of @${handle}`);
    return { username: handle, following: true };
  },
});
