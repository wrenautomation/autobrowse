import { describe, expect, it } from "vitest";
import { instagramCreatePost } from "../src/browser/flows/instagram-create-post.js";
import type { Hints } from "../src/browser/locate.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { instagram } from "../src/sites/instagram.js";
import { fakePage } from "./auth-fakes.js";

const line = (a: { op: { kind: string }; hints: Hints }) =>
  `${a.op.kind} ${a.hints.name ?? a.hints.css}`;
const RAIL = '<a href="/wrenautomation/"><img alt="wrenautomation\'s profile picture"></a>';

describe("instagram/create-post", () => {
  it("is the web-post route's browser leg, told which account it posts as", () => {
    const route = instagram.routes.find((r) => r.path === "/web/posts");
    expect(route?.browser?.flow).toBe("instagram/create-post");
    expect(route?.irreversible).toBe(true);
    expect(
      route?.browser?.input?.({ file: "/tmp/a.png" }, (n) =>
        n === "INSTAGRAM_ACCOUNT" ? "wrenautomation" : undefined,
      ),
    ).toEqual({ file: "/tmp/a.png", account: "wrenautomation" });
    expect(BROWSER_FLOWS["instagram/create-post"]).toBe(instagramCreatePost);
  });

  it("walks the four dialogs and answers with the new post's link", async () => {
    let shared = false;
    const { fp, acts } = fakePage({
      text: ["", "", "", "", "", "Your post has been shared."],
      present: () => true,
      url: "https://www.instagram.com/",
      onAct: (n) => {
        if (n === 6) shared = true;
      },
    });
    fp.html = async () =>
      shared ? `${RAIL}<a href="/p/NEW/">new</a><a href="/p/OLD/">old</a>` : `${RAIL}<a href="/p/OLD/">old</a>`;
    const out = await instagramCreatePost.run(fp, {
      file: "/tmp/a.png",
      caption: "hello",
      account: "wrenautomation",
    });
    expect(acts.map(line)).toEqual([
      "click New post",
      'click a:has(svg[aria-label="Post"])',
      "upload div[role=dialog] input[type=file]",
      "click /^next$/i",
      "click /^next$/i",
      "fill /add a caption/i",
      "click /^share$/i",
    ]);
    expect(out).toEqual({ url: "https://www.instagram.com/p/NEW/" });
  });

  it("refuses when the profile is signed in as another account", async () => {
    const { fp, acts } = fakePage({ text: [""], present: () => true });
    fp.html = async () => RAIL;
    await expect(
      instagramCreatePost.run(fp, { file: "/tmp/a.png", account: "someoneelse" }),
    ).rejects.toThrow(/posts as @wrenautomation/);
    expect(acts).toEqual([]);
  });

  it("hands over when the composer never opens, before any upload", async () => {
    const { fp, acts } = fakePage({ text: [""], present: (h) => !/dialog/.test(String(h.css)) });
    fp.html = async () => RAIL;
    await expect(instagramCreatePost.run(fp, { file: "/tmp/a.png" })).rejects.toThrow(
      /composer did not open/,
    );
    expect(acts.map(line)).toEqual(["click New post", 'click a:has(svg[aria-label="Post"])']);
  });
});
