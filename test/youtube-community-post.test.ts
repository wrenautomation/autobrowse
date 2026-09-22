import { describe, expect, it } from "vitest";
import { youtubeCommunityPost } from "../src/browser/flows/youtube-community-post.js";
import type { Hints } from "../src/browser/locate.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { youtube } from "../src/sites/youtube.js";
import { fakePage } from "./auth-fakes.js";

const line = (a: { op: { kind: string }; hints: Hints }) =>
  `${a.op.kind} ${a.hints.name ?? a.hints.css}`;

describe("google/youtube-community-post", () => {
  it("is the community post route's browser leg", () => {
    const route = youtube.routes.find((r) => r.path === "/studio/communityPosts");
    expect(route?.browser?.flow).toBe("google/youtube-community-post");
    expect(
      route?.browser?.input?.({ text: "hi" }, (n) =>
        n === "YOUTUBE_CHANNEL_ID" ? "UC1" : undefined,
      ),
    ).toEqual({
      text: "hi",
      channel: "UC1",
    });
    expect(route?.irreversible).toBe(true);
    expect(BROWSER_FLOWS["google/youtube-community-post"]).toBe(youtubeCommunityPost);
  });

  it("opens the editor, types, attaches, posts, and answers with the new post's link", async () => {
    let posted = false;
    const { fp, acts } = fakePage({
      text: [""],
      present: () => true,
      url: "https://www.youtube.com/channel/UC1/posts",
      onAct: (n) => {
        if (n === 4) posted = true;
      },
    });
    fp.html = async () =>
      posted
        ? '<a href="/post/NEW?x=1">new</a><a href="/post/OLD">old</a>'
        : '<a href="/post/OLD">old</a>';
    const out = await youtubeCommunityPost.run(fp, {
      text: "hello",
      image: "/tmp/a.png",
      channel: "UC1",
    });
    expect(acts.map(line)).toEqual([
      "click What's on your mind?",
      "fill #contenteditable-root",
      "upload Add an image",
      "click /^post$/i",
    ]);
    expect(acts[3]?.op).toEqual({ kind: "click" });
    expect(out).toEqual({ url: "https://www.youtube.com/post/NEW" });
  });

  it("hands over when the Post button never enables", async () => {
    const { fp } = fakePage({
      text: [""],
      present: (h) => !/post/.test(String(h.name)),
      url: "https://www.youtube.com/channel/UC1/posts",
    });
    await expect(youtubeCommunityPost.run(fp, { text: "hello", channel: "UC1" })).rejects.toThrow(
      /Post button did not enable/,
    );
  });

  it("refuses when the profile is on another channel, or none was named", async () => {
    const page = () =>
      fakePage({
        text: [""],
        present: () => true,
        url: "https://www.youtube.com/channel/UC1/posts",
      });
    await expect(
      youtubeCommunityPost.run(page().fp, { text: "hello", channel: "UC-other" }),
    ).rejects.toThrow(/posts as channel UC1, not UC-other/);
    await expect(youtubeCommunityPost.run(page().fp, { text: "hello" })).rejects.toThrow(
      /no channel was named/,
    );
  });
});
