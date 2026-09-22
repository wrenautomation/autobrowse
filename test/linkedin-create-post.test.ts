import { describe, expect, it } from "vitest";
import { linkedinCreatePost } from "../src/browser/flows/linkedin-create-post.js";
import type { Hints } from "../src/browser/locate.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { LINKEDIN_AUTHOR, linkedin } from "../src/sites/linkedin.js";
import { fakePage } from "./auth-fakes.js";

const line = (a: { op: { kind: string }; hints: Hints }) =>
  `${a.op.kind} ${a.hints.name ?? a.hints.css}`;

describe("linkedin/create-post", () => {
  it("is the posts route's browser leg, told which author it posts as", () => {
    const route = linkedin.routes.find((r) => r.path === "/rest/posts" && r.method === "POST");
    expect(route?.browser?.flow).toBe("linkedin/create-post");
    expect(route?.irreversible).toBe(true);
    expect(
      route?.browser?.input?.({ commentary: "hi", visibility: "PUBLIC" }, (n) =>
        n === LINKEDIN_AUTHOR ? "Wren Automation" : undefined,
      ),
    ).toEqual({ text: "hi", visibility: "PUBLIC", author: "Wren Automation" });
    expect(BROWSER_FLOWS["linkedin/create-post"]).toBe(linkedinCreatePost);
  });

  it("switches the author, types the post and answers with its permalink", async () => {
    let posted = false;
    const { fp, acts } = fakePage({
      text: ["", "", "", "", "Post successful"],
      present: () => true,
      read: () => "Post to Anyone",
      url: "https://www.linkedin.com/sharing/compose",
      onAct: (n) => {
        if (n === 5) posted = true;
      },
    });
    fp.html = async () =>
      posted ? '<div data-urn="urn:li:activity:7300000000000000000"></div>' : "";
    const out = await linkedinCreatePost.run(fp, {
      text: "hello",
      author: "Wren Automation",
      visibility: "PUBLIC",
    });
    expect(acts.map(line)).toEqual([
      "click div[role=button][aria-expanded]",
      "click Wren Automation",
      "click /^(done|save)$/i",
      "fill div[role=textbox]",
      "click /^post$/i",
    ]);
    expect(out).toEqual({
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000000/",
    });
  });

  it("refuses an author this account cannot post as, before anything is typed", async () => {
    const { fp, acts } = fakePage({
      text: [""],
      present: (h) => h.role !== "radio",
      read: () => "Post to Anyone",
    });
    await expect(
      linkedinCreatePost.run(fp, { text: "hi", author: "Someone Else" }),
    ).rejects.toThrow(/not an author this account can post as/);
    expect(acts.map(line)).toEqual(["click div[role=button][aria-expanded]"]);
  });

  it("hands over when the composer never renders, before any act", async () => {
    const { fp, acts } = fakePage({ text: [""], present: () => false });
    await expect(linkedinCreatePost.run(fp, { text: "hi" })).rejects.toThrow(
      /composer did not open/,
    );
    expect(acts).toEqual([]);
  });
});
