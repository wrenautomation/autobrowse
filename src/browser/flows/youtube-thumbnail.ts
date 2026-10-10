/**
 * A video's custom thumbnail through YouTube Studio: the API's
 * `thumbnails.set` refuses Shorts, Studio's details page takes them. Mapped
 * 2026-10-09 in explore as google@wren on /video/<id>/edit: the Thumbnail
 * section's file input (`ytcp-thumbnail-uploader input#file-loader`) stages
 * the image (a button named after the file shows), "Save" enables and keeps
 * it; "Undo changes" drops it. Saving is the irreversible act.
 */
import { defineFlow } from "../flow.js";

export interface ThumbnailInput {
  videoId: string;
  /** The image, a local path by now (the route downloads a URL first). */
  file: string;
  /** The channel the video must sit on (`UC…`); Studio follows whoever this profile is. */
  channel?: string;
  /** Stage the image, then undo instead of saving. */
  dry?: boolean;
}

const LAND_MS = 20_000;
const save = { role: "button", name: "Save" } as const;

export const youtubeThumbnail = defineFlow<
  ThumbnailInput,
  { videoId: string; saved: boolean; dry?: boolean }
>({
  site: "google",
  name: "youtube-thumbnail",
  async run(fp, input) {
    await fp.open(`https://studio.youtube.com/video/${encodeURIComponent(input.videoId)}/edit`);
    if (!(await fp.has({ role: "heading", name: "Video details" }, LAND_MS)))
      return fp.human(`Studio showed no details page for ${input.videoId} (${fp.url()})`);
    // The "Channel content" link names the channel this Studio is on.
    const href = await fp.page
      .locator('a[href*="/channel/UC"][href$="/videos"]')
      .first()
      .getAttribute("href", { timeout: 5_000 })
      .catch(() => null);
    const landed = /\/channel\/(UC[\w-]+)\/videos/.exec(href ?? "")?.[1] ?? "";
    if (!input.channel)
      return fp.human(
        `no channel was named; this profile is on ${landed || "no channel"}. Set YOUTUBE_CHANNEL_ID`,
      );
    if (landed !== input.channel)
      return fp.human(
        `this profile is on channel ${landed || "none"}, not ${input.channel}: sign it in as the owner`,
      );
    await fp.act(
      { kind: "upload", files: [input.file] },
      { css: "ytcp-thumbnail-uploader input#file-loader" },
      { goal: "stage the thumbnail" },
    );
    const name = input.file.split("/").pop() ?? "";
    if (!(await fp.has({ role: "button", name }, LAND_MS)))
      return fp.human(
        "the thumbnail never showed (too small, too big, or the channel lacks custom thumbnails)",
      );
    if (input.dry) {
      await fp.act(
        { kind: "click" },
        { role: "button", name: "Undo changes" },
        { goal: "drop the staged thumbnail" },
      );
      return { videoId: input.videoId, saved: false, dry: true };
    }
    await fp.act({ kind: "click" }, save, { goal: "save the thumbnail", irreversible: true });
    // Saved once the button greys out again.
    const button = fp.page.getByRole("button", { name: "Save", exact: true });
    for (let i = 0; i < 15; i++) {
      await fp.wait(1_000);
      if (await button.isDisabled().catch(() => false))
        return { videoId: input.videoId, saved: true };
    }
    return fp.human("Save never settled");
  },
});
