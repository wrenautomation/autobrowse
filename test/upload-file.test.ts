import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extOf, withLocalFile } from "../src/sites/upload-file.js";

const answering = (body: string, status = 200) =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("withLocalFile", () => {
  it("passes a path through untouched", async () => {
    const seen = await withLocalFile({ file: "/data/a.mp4", caption: "x" }, "file", async (i) => i);
    expect(seen).toEqual({ file: "/data/a.mp4", caption: "x" });
  });

  it("downloads a URL, hands the leg the path, and removes it after", async () => {
    let path = "";
    const url = "https://bucket.s3.amazonaws.com/media/abc.mp4?X-Amz-Signature=zzz";
    const out = await withLocalFile(
      { file: url, caption: "hi" },
      "file",
      async (i) => {
        path = String(i.file);
        expect(path.endsWith("/media.mp4")).toBe(true);
        expect(readFileSync(path, "utf8")).toBe("bytes");
        expect(i.caption).toBe("hi");
        return "posted";
      },
      { fetch: answering("bytes") },
    );
    expect(out).toBe("posted");
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a URL that does not answer, without running the leg", async () => {
    let ran = false;
    await expect(
      withLocalFile(
        { file: "https://x/y.jpg" },
        "file",
        async () => {
          ran = true;
        },
        { fetch: answering("gone", 403) },
      ),
    ).rejects.toThrow("answered 403");
    expect(ran).toBe(false);
  });

  it("takes the extension from the path, not the query", () => {
    expect(extOf("https://b/media/k.JPG?sig=a.b")).toBe(".jpg");
    expect(extOf("not a url")).toBe("");
  });
});
