import { describe, expect, it } from "vitest";
import { folded, handleOf, videoIdsOf } from "./tiktok-create-post.js";

describe("tiktok create-post read back", () => {
  it("takes video ids from links, deduped, in page order", () => {
    expect(
      videoIdsOf([
        "https://www.tiktok.com/@acme/video/7400000000000000002",
        "https://www.tiktok.com/@acme/video/7400000000000000001?is_from_webapp=1",
        "https://www.tiktok.com/@acme/video/7400000000000000002",
        "https://www.tiktok.com/@acme/photo/7400000000000000003",
        "https://www.tiktok.com/tiktokstudio/content",
      ]),
    ).toEqual(["7400000000000000002", "7400000000000000001"]);
  });

  it("reads the handle off the profile URL", () => {
    expect(handleOf("https://www.tiktok.com/@acme.co_1?lang=en")).toBe("acme.co_1");
    expect(handleOf("https://www.tiktok.com/profile")).toBeNull();
  });

  it("compares captions with whitespace folded", () => {
    expect(folded(" Line one\n\nline  two ")).toBe(folded("Line one line two"));
  });
});
