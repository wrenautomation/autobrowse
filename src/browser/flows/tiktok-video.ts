/**
 * Open one TikTok video in the app. From 2026-10-29 TikTok's edge answers 403 to a full load of
 * `/@x/video/<id>`, signed in or not (a reload too); the profile loads, and a click on its grid
 * tile opens the video in the browse view (`browse-*` controls). A pushState to the video URL
 * renders nothing, and the oEmbed and embed calls name no author, so a video with no handle is
 * looked for on our own profile (the side menu's Profile): wren sends a handle for every video
 * but ours.
 */
import type { FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";
import { RENDER_MS, SETTLE_MS } from "./kit.js";

const WEB = "https://www.tiktok.com";
/** Each scroll loads about 30 tiles; past this a video is too old to act on. */
const GRID_SCROLLS = 15;
const CLICKS = 3;
const NO_ACCOUNT = /couldn.t find this account/i;
const anyTile: Hints = { css: 'a[href*="/video/"]' };
const browseView: Hints = { css: '[data-e2e="browse-video"]' };
const ownProfile: Hints = { css: '[data-e2e="nav-profile"]' };

/** The page's own data, as text. */
export const DATA_SCRIPT = `document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent ?? null`;

/** The profile owner's id in a profile page's data (`webapp.user-detail`), or null. */
export function profileUserIdIn(json: string | null): string | null {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as {
      __DEFAULT_SCOPE__?: Record<string, { userInfo?: { user?: { id?: unknown } } } | undefined>;
    };
    const id = data.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo?.user?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export type OpenedVideo =
  | { opened: true; authorId: string | null }
  | { opened: false; reason: string };

export async function openVideo(
  fp: FlowPage,
  videoId: string,
  username?: string,
): Promise<OpenedVideo> {
  let handle = (username ?? "").trim().replace(/^@/, "");
  if (!handle) {
    await fp.open(`${WEB}/explore`);
    await fp.act({ kind: "click" }, ownProfile, { goal: "open our profile" });
    for (let i = 0; i < RENDER_MS / SETTLE_MS && !handle; i++) {
      await fp.wait(SETTLE_MS);
      handle = decodeURIComponent(/\/@([^/?#]+)/.exec(fp.url())?.[1] ?? "");
    }
    if (!handle) return { opened: false, reason: `our profile did not open (${fp.url()})` };
  }
  // a full load: the profile's data names its owner
  await fp.open(`${WEB}/@${encodeURIComponent(handle)}`);
  const who = `@${handle}`;
  const authorId = profileUserIdIn(
    await fp.page.evaluate<string | null>(DATA_SCRIPT).catch(() => null),
  );
  const tile: Hints = { css: `a[href*="/video/${videoId}"]` };
  for (let i = 0; i <= GRID_SCROLLS; i++) {
    if (await fp.has(tile, i ? SETTLE_MS : RENDER_MS)) {
      // a click before the grid's script is live does nothing (seen live): again, a few times
      for (let c = 0; c < CLICKS; c++) {
        await fp.act({ kind: "click" }, tile, { goal: `open video ${videoId}` });
        // the browse view can show before the URL moves
        if (await fp.has(browseView, RENDER_MS)) return { opened: true, authorId };
      }
      return fp.human(`video ${videoId} did not open from ${who}'s grid`);
    }
    if (NO_ACCOUNT.test(await fp.text()))
      return { opened: false, reason: `no TikTok account ${who}` };
    await fp.scroll(4_000);
  }
  // No tile at all: the grid did not load (a block, a modal), not a video that is gone.
  if (!(await fp.has(anyTile))) return fp.human(`${who}'s video grid did not load (${fp.url()})`);
  return { opened: false, reason: `no video ${videoId} in ${who}'s grid` };
}
