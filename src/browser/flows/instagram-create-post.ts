/**
 * A post from a local file, which the API cannot do: publishing through
 * graph.instagram.com wants the media at a public URL, and a file on this
 * machine has none. Mapped 2026-09-22 in headless explore on
 * instagram.com: the "New post" rail item opens a small menu whose "Post"
 * entry opens the composer, and the composer is four dialogs —
 * "Create new post" (a file input behind "Select from computer"), "Crop"
 * (Next), "Edit" (the filters, Next), then "Create new post" again with
 * the caption box and Share. Share is the irreversible act; the route
 * says so, and a run that is not approved stops before it.
 */
import { defineFlow } from "../flow.js";
import type { Hints } from "../locate.js";

export interface CreatePostInput {
  /** A local image or video file. */
  file: string;
  caption?: string;
  /** The account this post belongs on, as the profile must be signed in as it. */
  account?: string;
}

const HOME = "https://www.instagram.com/";
const SETTLE_MS = 2_000;
/** Instagram renders each composer dialog after a beat; the next one is awaited, not assumed. */
const DIALOG_MS = 20_000;

const dialog = (name: string): Hints => ({ css: `div[role=dialog][aria-label="${name}"]` });
const next: Hints = { role: "button", name: "/^next$/i" };
const caption: Hints = { role: "textbox", name: "/add a caption/i" };

export const instagramCreatePost = defineFlow<CreatePostInput, { url: string | null }>({
  site: "instagram",
  name: "create-post",
  async run(fp, input) {
    await fp.open(HOME);
    if (input.account) {
      const who = await signedInAs(fp);
      if (who && who.toLowerCase() !== input.account.toLowerCase().replace(/^@/, ""))
        return fp.human(
          `this profile posts as @${who}, not @${input.account}: sign it in as that account`,
        );
    }
    const before = await postLinks(fp, input.account ?? (await signedInAs(fp)) ?? "");
    // The rail item opens a menu (Post / Live video / Ad); its Post entry
    // carries the icon, so the icon is what names it.
    await fp.act(
      { kind: "click" },
      { role: "link", name: "New post" },
      { goal: "open the create menu" },
    );
    await fp.act(
      { kind: "click" },
      { css: 'a:has(svg[aria-label="Post"])' },
      { goal: "choose a post" },
    );
    if (!(await fp.has(dialog("Create new post"), DIALOG_MS)))
      return fp.human("the composer did not open");
    await fp.act(
      { kind: "upload", files: [input.file] },
      { css: "div[role=dialog] input[type=file]" },
      { goal: "choose the media file" },
    );
    // Crop, then Edit: the defaults are what we want, so each is one Next.
    for (const step of ["Crop", "Edit"] as const) {
      if (!(await fp.has(dialog(step), DIALOG_MS)))
        return fp.human(`the composer did not reach ${step} (on ${fp.url()})`);
      await fp.act({ kind: "click" }, next, { goal: `past ${step.toLowerCase()}` });
    }
    if (!(await fp.has(caption, DIALOG_MS))) return fp.human("no caption box in the composer");
    if (input.caption)
      await fp.act({ kind: "fill", value: input.caption }, caption, { goal: "type the caption" });
    const share = { role: "button", name: "/^share$/i" } as const;
    if (!(await fp.has(share, 5_000))) return fp.human("no Share button in the composer");
    await fp.act({ kind: "click" }, share, { goal: "publish the post", irreversible: true });
    // Instagram uploads, then says so; the profile gains the post a moment later.
    for (let i = 0; i < 15; i++) {
      await fp.wait(SETTLE_MS);
      const text = await fp.text();
      if (/something went wrong|couldn.t share|try again/i.test(text))
        return fp.human(`Instagram did not take the post: ${text.slice(0, 200)}`);
      if (!/your post has been shared|post shared/i.test(text)) continue;
      const who = input.account ?? (await signedInAs(fp)) ?? "";
      for (let j = 0; j < 10; j++) {
        await fp.open(`${HOME}${who}/`);
        const fresh = (await postLinks(fp, who)).filter((u) => !before.includes(u));
        if (fresh[0]) return { url: fresh[0] };
        await fp.wait(SETTLE_MS);
      }
      return { url: null };
    }
    return fp.human(`the composer never confirmed the post (on ${fp.url()})`);
  },
});

/** The handle the rail shows for the signed-in account, or null when the page does not say. */
async function signedInAs(fp: { html(): Promise<string> }): Promise<string | null> {
  const html = await fp.html();
  return (
    /href="\/([A-Za-z0-9._]+)\/"[^>]*>\s*<img[^>]+alt="[^"]*'s profile picture/.exec(html)?.[1] ??
    null
  );
}

/** Links to this account's posts on the page, newest first as Instagram lists them. */
async function postLinks(fp: { html(): Promise<string> }, _who: string): Promise<string[]> {
  const html = await fp.html();
  const out: string[] = [];
  for (const m of html.matchAll(/href="(\/(?:p|reel)\/[^"?/]+)\/?"/g)) {
    const u = `https://www.instagram.com${m[1]}/`;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}
