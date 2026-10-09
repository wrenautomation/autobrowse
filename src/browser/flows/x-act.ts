/**
 * X acts through the signed-in page, in API v2's answer shapes: follow a user, like a post,
 * reply to one. X's free API tier has no follow or like, and the page costs nothing, so the x
 * routes send these here; each is capped per account (sites/x.ts).
 *
 * Mapped 2026-10-09 in explore as x@wren (@wren_automation). A profile's button is
 * `[data-testid="<userId>-follow"]` labelled "Follow @handle", `-unfollow` ("Following @handle")
 * once followed; unfollowing asks again (`confirmationSheetConfirm`). A post page's focal
 * `article` carries `[data-testid=like]` (`unlike` once liked), and under it the inline reply
 * box `tweetTextarea_0` with `tweetButtonInline`. The rail's `AppTabBar_Profile_Link` names us.
 */
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";

const WEB = "https://x.com";
const RENDER_MS = 15_000;
const SETTLE_MS = 1_000;

const SIGNED_OUT = /\/(i\/flow\/login|login)\b/;
const MISSING =
  /this account doesn.t exist|account suspended|this post is from an account that no longer exists|hmm\.\.\.this page doesn.t exist|this post was deleted/i;

/** X API v2's missing-thing answer, as the read flows give it. */
const notFound = (detail: string) => ({
  errors: [{ title: "Not Found Error" as const, detail }],
});

async function openX(fp: FlowPage, url: string): Promise<void> {
  await fp.open(url);
  if (SIGNED_OUT.test(fp.url()))
    fp.human("X is signed out on this profile: `autobrowse login x@<account>`");
}

/** Which of `hints` shows first within the render time; "missing" when the page says so. */
async function first(fp: FlowPage, hints: Hints[]): Promise<number | "missing" | null> {
  for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
    for (const [n, h] of hints.entries()) if (await fp.has(h)) return n;
    if (MISSING.test(await fp.text())) return "missing";
    await fp.wait(SETTLE_MS);
  }
  return null;
}

const label = (handle: string) => handle.replace(/"/g, "");
export const followButton = (handle: string): Hints => ({
  css: `[data-testid$="-follow"][aria-label="Follow @${label(handle)}" i]`,
});
export const followingButton = (handle: string): Hints => ({
  css: `[data-testid$="-unfollow"][aria-label="Following @${label(handle)}" i]`,
});
const confirm: Hints = { css: "[data-testid=confirmationSheetConfirm]" };

export interface FollowInput {
  username: string;
  /** Unfollow instead. */
  undo?: boolean;
}

export const xFollow = defineFlow<FollowInput, unknown>({
  site: "x",
  name: "follow",
  async run(fp, { username, undo }) {
    await openX(fp, `${WEB}/${username}`);
    const on = followingButton(username);
    const off = followButton(username);
    const state = await first(fp, [on, off]);
    if (state === "missing") return notFound(`no X user @${username}`);
    if (state === null) return fp.human(`no Follow button on @${username} (${fp.url()})`);
    const following = state === 0;
    if (following === !undo) return { data: { following, pending_follow: false, already: true } };
    if (undo) {
      await fp.act({ kind: "click" }, on, { goal: `unfollow @${username}` });
      if (await fp.has(confirm, 5_000))
        await fp.act({ kind: "click" }, confirm, { goal: "confirm the unfollow" });
    } else await fp.act({ kind: "click" }, off, { goal: `follow @${username}` });
    if (!(await fp.has(undo ? off : on, RENDER_MS)))
      return fp.human(`X did not take the ${undo ? "unfollow" : "follow"} of @${username}`);
    return { data: { following: !undo, pending_follow: false } };
  },
});

/** The post's own article on its page: replies below carry their own buttons. */
const focal = (id: string) => `article:has(a[href*="/status/${id}"] time)`;
export const likeButton = (id: string): Hints => ({ css: `${focal(id)} [data-testid=like]` });
export const unlikeButton = (id: string): Hints => ({ css: `${focal(id)} [data-testid=unlike]` });

export interface LikeInput {
  id: string;
  undo?: boolean;
}

export const xLike = defineFlow<LikeInput, unknown>({
  site: "x",
  name: "like",
  async run(fp, { id, undo }) {
    await openX(fp, `${WEB}/i/status/${id}`);
    const on = unlikeButton(id);
    const off = likeButton(id);
    const state = await first(fp, [on, off]);
    if (state === "missing") return notFound(`no X post ${id}`);
    if (state === null) return fp.human(`no Like button on post ${id} (${fp.url()})`);
    const liked = state === 0;
    if (liked === !undo) return { data: { liked, already: true } };
    await fp.act({ kind: "click" }, undo ? on : off, {
      goal: `${undo ? "unlike" : "like"} post ${id}`,
    });
    if (!(await fp.has(undo ? off : on, RENDER_MS)))
      return fp.human(`X did not take the ${undo ? "unlike" : "like"} on post ${id}`);
    return { data: { liked: !undo } };
  },
});

const replyBox: Hints = { css: "[data-testid=tweetTextarea_0]" };
const replyButton: Hints = { css: "[data-testid=tweetButtonInline]" };

/** The signed-in handle, from the rail's profile link. */
export function meOf(html: string): string | null {
  const a = /<a\b[^>]*data-testid="AppTabBar_Profile_Link"[^>]*>/.exec(html)?.[0];
  return a ? (/href="\/([A-Za-z0-9_]{1,15})"/.exec(a)?.[1] ?? null) : null;
}

/** Post ids by `handle` linked on the page. */
export function postsBy(html: string, handle: string): string[] {
  const re = new RegExp(`href="/${handle}/status/(\\d+)"`, "gi");
  return [...new Set([...html.matchAll(re)].map((m) => m[1] as string))];
}

export interface ReplyInput {
  /** The post to answer. */
  id: string;
  text: string;
}

export const xReply = defineFlow<ReplyInput, unknown>({
  site: "x",
  name: "reply",
  async run(fp, { id, text }) {
    await openX(fp, `${WEB}/i/status/${id}`);
    const box = await first(fp, [replyBox]);
    if (box === "missing") return notFound(`no X post ${id}`);
    if (box === null)
      return fp.human(`no reply box under post ${id}: replies may be limited to people it names`);
    const before = await fp.html();
    const me = meOf(before);
    if (!me) return fp.human("could not tell which X account this profile is signed in as");
    const seen = new Set(postsBy(before, me));
    await fp.act({ kind: "fill", value: text }, replyBox, { goal: "type the reply" });
    await fp.wait(SETTLE_MS);
    await fp.act({ kind: "click" }, replyButton, {
      goal: `reply to post ${id}`,
      irreversible: true,
    });
    for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
      await fp.wait(SETTLE_MS);
      const page = await fp.text();
      if (/something went wrong|you are over the daily limit|try again/i.test(page))
        return fp.human(`X did not take the reply: ${page.slice(0, 200)}`);
      const fresh = postsBy(await fp.html(), me).find((p) => p !== id && !seen.has(p));
      if (fresh) return { data: { id: fresh, text } };
    }
    // Sent, as far as the page says, but our reply never rendered: no id to keep.
    return { data: { id: null, text } };
  },
});
