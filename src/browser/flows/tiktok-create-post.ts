/**
 * A public TikTok post from a video file, on TikTok Studio's upload page.
 * The Content Posting API can't do it for an unaudited app (its posts are
 * SELF_ONLY), so the browser posts as the signed-in account. Mapped
 * 2026-10-14 in headless explore as tiktok (Google sign-in):
 *
 * - `/tiktokstudio/upload` holds a hidden `input[type=file]`; a file there
 *   opens the form at once, the upload runs beside it ("Uploaded (58.9MB)").
 * - First-run popups sit over the form: "Turn on automatic content
 *   checks?" (Cancel keeps the account's settings as they are) and tips
 *   with "Got it" ("New editing features added", "Preview your video on
 *   your phone"). Each is cleared when seen; none is required.
 * - The caption is a Draft.js `div[contenteditable][role=combobox]`
 *   holding the file name; a fill replaces it and the "n/4000" counter
 *   follows, so the editor took it.
 * - "Who can see this post" is a combobox (Everyone by default). "Show
 *   more" reveals "Allow users to: Comment | Reuse of content" (both on by
 *   default) and the "AI-generated content" switch. Until then the whole
 *   panel is `<div hidden>`: its inputs are in the page but cannot be
 *   clicked. Their ids are random, so they are found by the label beside
 *   them. A checkbox's input is not visible itself (its `<label>` is the
 *   control); a switch's input is `aria-hidden` inside `.Switch__content`.
 *   Mapped from a failed run's trace 2026-10-14: the first off-click went
 *   straight to the hidden input and timed out.
 * - Post is `button[data-e2e=post_video_button]`, enabled once uploaded.
 *
 * Read back: the account's profile grid before and after; the new
 * `/video/<id>` link is the post. Nothing after the Post click throws: a
 * post that went out but is not on the grid yet answers `id: null` with a
 * note, so no retry posts it twice.
 */
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";

const WEB = "https://www.tiktok.com";
const UPLOAD = `${WEB}/tiktokstudio/upload`;
/** The Studio form renders after a beat. */
const RENDER_MS = 30_000;
/** A large file on a slow line: the upload, then TikTok's check of it. */
const UPLOAD_MS = 15 * 60_000;
/** After Post: the confirmation, then the profile grid. */
const CONFIRM_MS = 3 * 60_000;
const READBACK_MS = 8 * 60_000;
const POLL_MS = 3_000;
/** "Show more" opens its panel at once; this is the wait for the page to show it. */
const OPEN_MS = 3_000;

export const TIKTOK_AUDIENCE = { everyone: "Everyone", friends: "Friends", "only-me": "Only you" };
export type TikTokAudience = keyof typeof TIKTOK_AUDIENCE;

export interface TikTokPostInput {
  /** A local video file (the facade downloads a URL to one first). */
  file: string;
  caption?: string;
  /** Who can see it; Studio's default, everyone. */
  privacy?: TikTokAudience;
  /** "Allow users to: Comment"; on by default, as Studio has it. */
  comments?: boolean;
  /** "Allow users to: Reuse of content" (duet and stitch); on by default. */
  reuse?: boolean;
  /** The "AI-generated content" label; off by default. */
  aiGenerated?: boolean;
}

export interface TikTokPost {
  /** The video's id; null when the post went out but the grid does not list it yet. */
  id: string | null;
  url: string | null;
  /** The account's profile, where the post shows. */
  profile: string;
  note?: string;
}

const fileInput: Hints = { css: "input[type=file]" };
const captionBox: Hints = { css: "div[contenteditable=true][role=combobox]" };
const postButton: Hints = { css: 'button[data-e2e="post_video_button"]' };
const checksDialog: Hints = {
  css: 'div[role=dialog]:has-text("automatic content checks") button:has-text("Cancel")',
};
const gotIt: Hints = { role: "button", name: "Got it" };
const cookies: Hints = { role: "button", name: "/^decline optional cookies$/i" };
const showMore: Hints = { text: "Show more" };

/** Every `/video/<id>` link on the page, in page order. */
const VIDEO_LINKS = `Array.from(document.querySelectorAll('a[href*="/video/"]')).map((a) => a.href)`;

/**
 * The form's checkboxes and switches by the label beside each: ids are random per load. `press` is
 * the control a person clicks (a checkbox's `<label>`, a switch's `.Switch__content`; the input
 * itself is hidden), `shown` whether it is on screen now (the panel starts `hidden`).
 */
export const TOGGLES = `Array.from(document.querySelectorAll('input[type=checkbox]')).map((i) => {
  let e = i;
  for (let k = 0; k < 6 && e && !(e.innerText || '').trim(); k++) e = e.parentElement;
  const press = i.closest('label') || i.closest('[aria-checked]');
  const on = (i.closest('[aria-checked]') || i).getAttribute('aria-checked');
  return {
    id: i.id,
    checked: on === 'true' || on === 'false' ? on === 'true' : i.checked,
    shown: !!press && press.getClientRects().length > 0,
    label: ((e && e.innerText) || '').replace(/\\s+/g, ' ').trim(),
  };
})`;

export interface Toggle {
  id: string;
  checked: boolean;
  shown: boolean;
  label: string;
}

/** Video ids in links, deduped, as the page lists them. */
export function videoIdsOf(links: string[]): string[] {
  const out: string[] = [];
  for (const l of links) {
    const id = /\/video\/(\d{6,})/.exec(l)?.[1];
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The handle in a profile URL (`/@handle?lang=en`), or null. */
export function handleOf(url: string): string | null {
  return /tiktok\.com\/@([A-Za-z0-9._]+)/.exec(url)?.[1] ?? null;
}

/** The caption as the editor holds it, whitespace folded, for comparing with what was typed. */
export const folded = (s: string) => s.replace(/\s+/g, " ").trim();

/** The account's handle and the ids its grid shows now. */
async function grid(fp: FlowPage): Promise<{ handle: string | null; ids: string[] }> {
  await fp.open(`${WEB}/profile`);
  await fp.wait(2_000);
  const handle = handleOf(fp.url());
  const links = (await fp.page.evaluate(VIDEO_LINKS).catch(() => [])) as string[];
  return { handle, ids: videoIdsOf(links) };
}

/** The first-run popups over the form, each cleared when it shows; none is required. */
async function clearPopups(fp: FlowPage): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (await fp.has(checksDialog))
      await fp.act({ kind: "click" }, checksDialog, {
        goal: "decline automatic content checks (the account's settings stay as they are)",
      });
    else if (await fp.has(gotIt)) await fp.act({ kind: "click" }, gotIt, { goal: "close the tip" });
    else if (await fp.has(cookies))
      await fp.act({ kind: "click" }, cookies, { goal: "decline optional cookies" });
    else return;
    await fp.wait(500);
  }
}

async function toggles(fp: FlowPage): Promise<Toggle[]> {
  return (await fp.page.evaluate(TOGGLES)) as Toggle[];
}

/** The control a person clicks for a toggle: its label (checkbox) or switch body, never the hidden input. */
const pressOf = (t: Toggle): Hints => ({
  css: `:is(label, [aria-checked]):has([id="${t.id}"])`,
});

/** "Show more" opens the panel the interaction toggles sit in; once it shows, a no-op. */
async function showMoreSettings(fp: FlowPage, label: string): Promise<void> {
  if (!(await fp.has(showMore))) return;
  await fp.act({ kind: "click" }, showMore, { goal: "show the interaction settings" });
  for (let t = 0; t < OPEN_MS; t += 250) {
    if ((await toggles(fp)).some((x) => x.label === label && x.shown)) return;
    await fp.wait(250);
  }
}

/**
 * Set one labelled checkbox or switch to `on`; null when done, else why not. Already right is left
 * alone. A row still hidden under "Show more" is opened first, and the click goes to the row's
 * visible control: the input itself is not clickable.
 */
export async function setToggle(fp: FlowPage, label: string, on: boolean): Promise<string | null> {
  const find = async () => (await toggles(fp)).find((x) => x.label === label);
  let t = await find();
  if (t?.checked === on) return null;
  if (!t?.shown) {
    await showMoreSettings(fp, label);
    t = await find();
  }
  if (!t) return `no "${label}" on the form`;
  if (t.checked === on) return null;
  if (!t.shown) return `"${label}" stayed hidden under Show more`;
  await fp.act({ kind: "click" }, pressOf(t), { goal: `turn ${label} ${on ? "on" : "off"}` });
  if (!(await settled(fp, label, on))) {
    // The body took the click but not the page: the input's own click, hidden or not, is the toggle.
    await fp.page.evaluate(`document.getElementById(${JSON.stringify(t.id)})?.click()`);
    if (await settled(fp, label, on)) return null;
    return `"${label}" did not turn ${on ? "on" : "off"}`;
  }
  return null;
}

/** The toggle reads `on` within a moment of a click. */
async function settled(fp: FlowPage, label: string, on: boolean): Promise<boolean> {
  for (let t = 0; t < 1_500; t += 250) {
    await fp.wait(250);
    if ((await toggles(fp)).find((x) => x.label === label)?.checked === on) return true;
  }
  return false;
}

const isEnabled = (fp: FlowPage) =>
  fp.page
    .locator(postButton.css as string)
    .first()
    .evaluate(
      (b: { disabled?: boolean; getAttribute(n: string): string | null }) =>
        !b.disabled && b.getAttribute("aria-disabled") !== "true",
    )
    .catch(() => false);

export const tiktokCreatePost = defineFlow<TikTokPostInput, TikTokPost>({
  site: "tiktok",
  name: "create-post",
  async run(fp, input) {
    const audience = TIKTOK_AUDIENCE[input.privacy ?? "everyone"];
    const before = await grid(fp);
    const profile = before.handle ? `${WEB}/@${before.handle}` : `${WEB}/profile`;

    await fp.open(UPLOAD);
    await fp.act({ kind: "upload", files: [input.file] }, fileInput, {
      goal: "choose the video file",
      timeoutMs: RENDER_MS,
    });
    if (!(await fp.has(captionBox, RENDER_MS)))
      return fp.human(`Studio did not open the post form (on ${fp.url()})`);
    await clearPopups(fp);

    // The caption: TikTok fills in the file name; ours replaces it.
    await fp.act({ kind: "fill", value: input.caption ?? "" }, captionBox, {
      goal: "type the caption",
    });
    const typed =
      (await fp.page
        .locator(captionBox.css as string)
        .first()
        .innerText()) ?? "";
    if (folded(typed) !== folded(input.caption ?? ""))
      return fp.human(`the caption box holds "${typed.slice(0, 120)}", not the caption`);

    // Who can see it: Everyone by default; any other pick is its option in the list.
    const shown = await fp.page
      .locator("button[role=combobox]", { hasText: /^(Everyone|Friends|Only you)$/ })
      .first()
      .innerText()
      .catch(() => "");
    if (!shown) return fp.human('no "Who can see this post" on the form');
    if (shown.trim() !== audience) {
      await fp.act(
        { kind: "click" },
        { css: `button[role=combobox]:has-text("${shown.trim()}")` },
        { goal: "open who can see this post" },
      );
      await fp.act(
        { kind: "click" },
        { role: "option", name: audience },
        {
          goal: `let ${audience.toLowerCase()} see it`,
        },
      );
    }

    // Comment, reuse and the AI label sit under "Show more"; a toggle already right is not touched.
    for (const [label, on] of [
      ["Comment", input.comments ?? true],
      ["Reuse of content", input.reuse ?? true],
      ["AI-generated content", input.aiGenerated ?? false],
    ] as const) {
      const miss = await setToggle(fp, label, on);
      if (miss) return fp.human(miss);
    }
    await clearPopups(fp);

    // The upload runs beside the form; Post opens once TikTok has the file.
    let ready = false;
    for (let t = 0; t < UPLOAD_MS && !ready; t += POLL_MS) {
      ready = await isEnabled(fp);
      if (ready) break;
      const text = await fp.text();
      if (/upload failed|couldn.t upload|unsupported/i.test(text))
        return fp.human(`TikTok did not take the file: ${text.slice(0, 200)}`);
      await clearPopups(fp);
      await fp.wait(POLL_MS);
    }
    if (!ready) return fp.human("the upload never finished (Post stayed off)");

    await fp.act({ kind: "click" }, postButton, { goal: "post the video", irreversible: true });

    // From here on nothing throws: the post may have gone out.
    let note: string | undefined;
    try {
      note = await confirmed(fp);
    } catch (err) {
      note = `no confirmation read after Post: ${err instanceof Error ? err.message : String(err)}`;
    }
    try {
      for (let t = 0; t < READBACK_MS; t += POLL_MS * 5) {
        const after = await grid(fp);
        const fresh = after.ids.find((id) => !before.ids.includes(id));
        if (fresh) {
          const handle = after.handle ?? before.handle;
          return {
            id: fresh,
            url: handle ? `${WEB}/@${handle}/video/${fresh}` : `${WEB}/video/${fresh}`,
            profile,
            ...(note ? { note } : {}),
          };
        }
        await fp.wait(POLL_MS * 5);
      }
    } catch (err) {
      note = `${note ? `${note}; ` : ""}read back failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return {
      id: null,
      url: null,
      profile,
      note: `${note ? `${note}; ` : ""}posted, but the profile does not list it yet`,
    };
  },
});

/**
 * What the page says after Post: undefined once it confirms, else the
 * words it showed. A "Post now" confirm (checks still running) is the same
 * post's yes.
 */
async function confirmed(fp: FlowPage): Promise<string | undefined> {
  const postNow: Hints = { role: "button", name: "/^post now$/i" };
  let last = "";
  for (let t = 0; t < CONFIRM_MS; t += POLL_MS) {
    await fp.wait(POLL_MS);
    if (/tiktokstudio\/content/.test(fp.url())) return undefined;
    if (await fp.has(postNow)) {
      await fp.act({ kind: "click" }, postNow, { goal: "post now", irreversible: true });
      continue;
    }
    last = await fp.text();
    if (
      /your video (has been|is being) (uploaded|posted)|video posted|manage your posts/i.test(last)
    )
      return undefined;
    if (/couldn.t post|failed to post|something went wrong/i.test(last))
      return `TikTok said: ${last.slice(0, 200)}`;
  }
  return `no confirmation in ${CONFIRM_MS / 1000}s (on ${fp.url()})`;
}
