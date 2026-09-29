/**
 * Loom through the signed-in web app: Loom has no public API for a video's
 * owner (its SDK records in a page; oEmbed only reads). Mapped 2026-09-29 in
 * explore as loom (william@, workspace wrenautomation):
 *
 * - `/home` has "Upload a video", which opens an Uppy dialog with an
 *   `input[type=file]` (.mp4 .mov .webm .wmv .avi .m4v, under 4 GB), then
 *   "Upload 1 file"; done says "Upload complete" and lists the file as a
 *   link to `/share/<id>` (it also opens that page in a new tab).
 * - A share page's title is a button "Rename video: <title>"; clicking it
 *   swaps in a focused text input, Enter saves.
 * - "More actions" (`[data-testid=toggleActions]`) → menuitem "Delete" →
 *   "Permanently delete".
 *
 * A new video is public to anyone with its link and never indexed; the
 * link is the post.
 */
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";

interface El {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelectorAll(sel: string): Iterable<El>;
}
declare const document: El;

export const LOOM = "https://www.loom.com";
/** A video's share page: its id is 32 hex characters. */
export const shareUrl = (id: string) => `${LOOM}/share/${id}`;
const ID = /\/share\/([0-9a-f]{32})/;
const DIALOG_MS = 20_000;
/** A large file on a slow link: the upload itself, then Loom's processing of it. */
const UPLOAD_MS = 20 * 60_000;
const POLL_MS = 3_000;

/** The Uppy dialog's own button: its `[role=dialog]` wrapper never reads as visible. */
const browseFiles: Hints = { role: "button", name: "browse files" };
const renameButton: Hints = { css: 'button[aria-label^="Rename video"]' };
/** The title's input once editing: it has no label, only focus. */
const titleBox: Hints = { css: "main input[type=text]:focus" };

export interface UploadInput {
  /** A local video file (the facade fetches a URL to one first). */
  file: string;
  title?: string;
}
export interface Video {
  id: string;
  url: string;
  title: string | null;
}

export const loomUpload = defineFlow<UploadInput, Video>({
  site: "loom",
  name: "upload",
  async run(fp, input) {
    await fp.open(`${LOOM}/home`);
    const upload: Hints = { role: "button", name: "Upload a video" };
    if (!(await fp.has(upload, DIALOG_MS))) return fp.human(`no "Upload a video" on ${fp.url()}`);
    await fp.act({ kind: "click" }, upload, { goal: "open the upload dialog" });
    if (!(await fp.has(browseFiles, DIALOG_MS))) return fp.human("the upload dialog did not open");
    await fp.act(
      { kind: "upload", files: [input.file] },
      { css: "[role=dialog] input[type=file]" },
      { goal: "choose the video file" },
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^Upload \\d+ files?$/" },
      { goal: "start the upload" },
    );
    const main = fp.page;
    let id: string | null = null;
    for (let t = 0; t < UPLOAD_MS && !id; t += POLL_MS) {
      await fp.wait(POLL_MS);
      id = await sharedId(fp);
      if (!id && /upload failed|failed to upload|error/i.test(await dialogText(fp)))
        return fp.human(`Loom did not take the upload: ${(await dialogText(fp)).slice(0, 200)}`);
    }
    if (!id) return fp.human("the upload never completed");
    for (const p of fp.pages()) if (p !== main) await p.close().catch(() => {});
    fp.switchTo(main);
    const title = input.title ? await rename(fp, id, input.title) : null;
    return { id, url: shareUrl(id), title };
  },
});

export interface RenameInput {
  id: string;
  title: string;
}

export const loomRename = defineFlow<RenameInput, Video>({
  site: "loom",
  name: "rename",
  async run(fp, input) {
    return {
      id: input.id,
      url: shareUrl(input.id),
      title: await rename(fp, input.id, input.title),
    };
  },
});

export const loomDelete = defineFlow<{ id: string }, { id: string; deleted: true }>({
  site: "loom",
  name: "delete",
  async run(fp, input) {
    await fp.open(shareUrl(input.id));
    const more: Hints = { css: "[data-testid=toggleActions]" };
    if (!(await fp.has(more, DIALOG_MS)))
      return fp.human(`no video ${input.id} to delete (on ${fp.url()})`);
    await fp.act({ kind: "click" }, more, { goal: "open the video's actions" });
    await fp.act({ kind: "click" }, { role: "menuitem", name: "Delete" }, { goal: "delete" });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Permanently delete" },
      { goal: "confirm the delete", irreversible: true },
    );
    if (!(await fp.waitForUrl((u) => !u.includes(input.id), DIALOG_MS)))
      return fp.human(`still on the video after the delete (${fp.url()})`);
    return { id: input.id, deleted: true };
  },
});

/** Set a video's title on its share page; answers the title the page then shows. */
async function rename(fp: FlowPage, id: string, title: string): Promise<string> {
  await fp.open(shareUrl(id));
  // A video fresh from an upload opens with its title box already focused and empty.
  let editing = false;
  for (let t = 0; t < DIALOG_MS && !editing; t += 500) {
    if (await fp.has(titleBox)) editing = true;
    else if (await fp.has(renameButton)) {
      await fp.act({ kind: "click" }, renameButton, { goal: "edit the title" });
      editing = true;
    } else await fp.wait(500);
  }
  if (!editing) return fp.human(`no title to rename on ${fp.url()}`);
  await fp.act({ kind: "fill", value: title }, titleBox, { goal: "type the title" });
  await fp.act({ kind: "press", key: "Enter" }, titleBox, { goal: "save" });
  for (let i = 0; i < 10; i++) {
    const shown = await shownTitle(fp);
    if (shown === title) return shown;
    await fp.wait(500);
  }
  return fp.human(`Loom kept the title "${await shownTitle(fp)}", not "${title}"`);
}

function shownTitle(fp: FlowPage): Promise<string> {
  return fp.page.evaluate(
    () =>
      [...document.querySelectorAll('button[aria-label^="Rename video"]')][0]
        ?.getAttribute("aria-label")
        ?.replace(/^Rename video:\s*/, "") ?? "",
  );
}

async function sharedId(fp: FlowPage): Promise<string | null> {
  const href = await fp.page.evaluate(
    () =>
      [...document.querySelectorAll('[role=dialog] a[href*="/share/"]')][0]?.getAttribute("href") ??
      "",
  );
  return ID.exec(href)?.[1] ?? null;
}

async function dialogText(fp: FlowPage): Promise<string> {
  return fp.page.evaluate(() =>
    [...document.querySelectorAll("[role=dialog]")].map((d) => d.textContent ?? "").join(" "),
  );
}
