/**
 * A YouTube community post, which has no API. The composer sits on the
 * channel's Posts tab in the `google` profile (the channel's owner).
 * Mapped 2026-09-21 in headless explore: "What's on your mind?" opens the
 * editor (`#contenteditable-root`), "Add an image" is a file chooser, "Post"
 * enables once there is text and publishes. The newest post's link is the
 * answer. Publishing is the irreversible act; the route says so.
 */
import { defineFlow } from "../flow.js";

export interface CommunityPostInput {
  text: string;
  /** An image file to attach. */
  image?: string;
}

/** Redirects to the signed-in channel's Posts tab (`/channel/<id>/posts`). */
const COMPOSER = "https://www.youtube.com/my_community";
const SETTLE_MS = 1_500;

export const youtubeCommunityPost = defineFlow<CommunityPostInput, { url: string | null }>({
  site: "google",
  name: "youtube-community-post",
  async run(fp, input) {
    await fp.open(COMPOSER);
    if (!(await fp.waitForUrl(/youtube\.com\/channel\/[^/]+\/posts/, 15_000)))
      return fp.human(`no Posts tab for this channel (landed on ${fp.url()})`);
    const before = await postLinks(fp);
    await fp.act(
      { kind: "click" },
      { role: "button", name: "What's on your mind?" },
      { goal: "open the post editor" },
    );
    await fp.act(
      { kind: "fill", value: input.text },
      { css: "#contenteditable-root" },
      {
        goal: "type the post",
      },
    );
    if (input.image) {
      await fp.act(
        { kind: "upload", files: [input.image] },
        { role: "button", name: "Add an image" },
        { goal: "attach the image" },
      );
      await fp.wait(3_000);
    }
    const post = { role: "button", name: "/^post$/i" } as const;
    if (!(await fp.has(post, 5_000))) return fp.human("the Post button did not enable");
    await fp.act({ kind: "click" }, post, { goal: "publish the post", irreversible: true });
    // The list gains the new post at the top; a moment for it to land.
    for (let i = 0; i < 10; i++) {
      await fp.wait(SETTLE_MS);
      const fresh = (await postLinks(fp)).filter((u) => !before.includes(u));
      if (fresh[0]) return { url: fresh[0] };
    }
    const text = await fp.text();
    if (/something went wrong|couldn.t post|try again/i.test(text))
      return fp.human(`YouTube did not take the post: ${text.slice(0, 200)}`);
    return { url: null };
  },
});

/** Links to posts on the page, newest first as YouTube lists them. */
async function postLinks(fp: { html(): Promise<string> }): Promise<string[]> {
  const html = await fp.html();
  const out: string[] = [];
  for (const m of html.matchAll(/href="(\/post\/[^"?]+)/g)) {
    const u = `https://www.youtube.com${m[1]}`;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}
