/**
 * LinkedIn acts on others through the signed-in page: like a post, follow a member or a company.
 * No API gives a member's reactions or follows to anyone but partners. Run as linkedin@wren only;
 * capped per account (sites/linkedin.ts).
 *
 * Mapped 2026-10-09 in explore as linkedin@wren. A post page (`/feed/update/<urn>/`) labels its
 * like "Reaction button state: no reaction" ("… like", "… celebrate" once reacted). A profile's
 * top card has "Follow <Name>" beside "Invite <Name> to connect"; a member whose main button is
 * Connect keeps Follow under "More". A company page shows "Follow <Company>". Once followed, the
 * label reads "Following <Name>" (or "Unfollow …").
 */
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";
import { go } from "./linkedin-reach.js";

const WEB = "https://www.linkedin.com";
const RENDER_MS = 15_000;
const SETTLE_MS = 1_000;

const MISSING = /this page doesn.t exist|page not found|this post (?:cannot|can.t) be displayed/i;

async function first(fp: FlowPage, hints: Hints[]): Promise<number | "missing" | null> {
  for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
    for (const [n, h] of hints.entries()) if (await fp.has(h)) return n;
    if (MISSING.test(await fp.text())) return "missing";
    await fp.wait(SETTLE_MS);
  }
  return null;
}

const unreacted: Hints = { role: "button", name: "/^reaction button state: no reaction$/i" };
const reacted: Hints = {
  role: "button",
  name: "/^reaction button state: (?!no reaction)\\w+/i",
};

export interface LikeInput {
  /** `urn:li:activity:N`, `urn:li:ugcPost:N` or `urn:li:share:N`. */
  urn: string;
  undo?: boolean;
}

export const linkedinLike = defineFlow<
  LikeInput,
  { urn: string; liked: boolean; already?: true } | { found: false; reason: string }
>({
  site: "linkedin",
  name: "like",
  async run(fp, { urn, undo }) {
    await go(fp, `${WEB}/feed/update/${urn}/`);
    const state = await first(fp, [reacted, unreacted]);
    if (state === "missing") return { found: false, reason: `no LinkedIn post ${urn}` };
    if (state === null) return fp.human(`no Like on post ${urn} (${fp.url()})`);
    const liked = state === 0;
    if (liked === !undo) return { urn, liked, already: true };
    await fp.act({ kind: "click" }, undo ? reacted : unreacted, {
      goal: `${undo ? "take back the like on" : "like"} post ${urn}`,
    });
    if (!(await fp.has(undo ? unreacted : reacted, RENDER_MS)))
      return fp.human(`LinkedIn did not take the ${undo ? "unlike" : "like"} on ${urn}`);
    return { urn, liked: !undo };
  },
});

// The first match is the top card's: "People also follow" sits below it in the page.
const off: Hints = { css: 'main button[aria-label^="Follow " i]' };
const on: Hints = {
  css: 'main button[aria-label^="Following " i], main button[aria-label^="Unfollow " i]',
};
const more: Hints = {
  css: 'main section button[aria-label="More" i], main section button[aria-label="More actions" i]',
};
const followItem: Hints = { css: 'main section div[role=button][aria-label^="Follow " i]' };
const unfollowItem: Hints = { css: 'main section div[role=button][aria-label^="Unfollow " i]' };
const confirmUnfollow: Hints = { role: "button", name: "/^unfollow$/i" };

export interface FollowInput {
  /** A member's `/in/<vanity>/`. */
  vanity?: string;
  /** Or a company's `/company/<handle>/`. */
  company?: string;
  undo?: boolean;
}

export const linkedinFollow = defineFlow<
  FollowInput,
  { following: boolean; already?: true } | { found: false; reason: string }
>({
  site: "linkedin",
  name: "follow",
  async run(fp, { vanity, company, undo }) {
    const who = vanity
      ? `/in/${encodeURIComponent(vanity)}/`
      : company
        ? `/company/${encodeURIComponent(company)}/`
        : null;
    if (!who) throw new Error("linkedin/follow: a vanity or a company");
    await go(fp, `${WEB}${who}`);
    let state = await first(fp, [on, off, more]);
    if (state === "missing") return { found: false, reason: `nothing at ${who}` };
    if (state === null) return fp.human(`no Follow on ${who} (${fp.url()})`);
    if (state === 2) {
      // Follow sits under More for a member whose main button is Connect.
      await fp.act({ kind: "click" }, more, { goal: "open More on the profile" });
      state = (await fp.has(unfollowItem, 5_000))
        ? 0
        : (await fp.has(followItem, 2_000))
          ? 1
          : null;
      if (state === null) return fp.human(`no Follow under More on ${who}`);
      const following = state === 0;
      if (following === !undo) return { following, already: true };
      await fp.act({ kind: "click" }, undo ? unfollowItem : followItem, {
        goal: `${undo ? "unfollow" : "follow"} ${who}`,
      });
    } else {
      const following = state === 0;
      if (following === !undo) return { following, already: true };
      await fp.act({ kind: "click" }, undo ? on : off, {
        goal: `${undo ? "unfollow" : "follow"} ${who}`,
      });
    }
    if (undo && (await fp.has(confirmUnfollow, 3_000)))
      await fp.act({ kind: "click" }, confirmUnfollow, { goal: "confirm the unfollow" });
    await fp.wait(SETTLE_MS);
    return { following: !undo };
  },
});
