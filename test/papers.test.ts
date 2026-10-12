/** Papers: sealed on disk, backed up to a bucket, refused when the bytes are not a document. */
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aesGcmCipher } from "credvault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LINK_SIGNATURE, mintDrop, takeDrop } from "../src/auth/link.js";
import {
  backedUpPapers,
  bucketPapers,
  describePaper,
  filePapers,
  memoryPapers,
  type PaperBucket,
  paperOf,
  paperPayload,
  paperRef,
  sniffType,
} from "../src/money/papers.js";

/** A 1x1 PNG: synthetic. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n%synthetic\n");
const at = new Date("2026-10-12T12:00:00Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "papers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a paper's record", () => {
  it("takes its type from the bytes, never the name, and refuses anything else", () => {
    expect(sniffType(PNG)).toBe("image/png");
    expect(sniffType(PDF)).toBe("application/pdf");
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffType(Buffer.from("<html>"))).toBeNull();
    expect(() => paperOf(Buffer.from("<html>"), { name: "x", kind: "passport" })).toThrow(
      /not a JPEG/,
    );
    const p = paperOf(PNG, { name: "licence-front", kind: "drivers-licence", side: "front" }, at);
    expect(p).toMatchObject({ type: "image/png", bytes: PNG.length, side: "front" });
    expect(describePaper(p)).toBe("licence-front: drivers-licence front, png 0 KB");
    expect(() => paperOf(PNG, { name: "Bad Name", kind: "passport" })).toThrow(/lowercase/);
  });

  it("names a paper in an upload as paper:<name>", () => {
    expect(paperRef("paper:licence-front")).toBe("licence-front");
    expect(paperRef("/tmp/a.png")).toBeNull();
    expect(paperRef("paper:../etc")).toBeNull();
  });
});

describe("the sealed copy", () => {
  it("round-trips sealed, 0600, with nothing readable on disk", async () => {
    const store = filePapers(join(dir, "papers"), aesGcmCipher(randomBytes(32)));
    const p = paperOf(PNG, { name: "licence-front", kind: "drivers-licence" }, at);
    await store.put(p, PNG);
    expect(await store.list()).toEqual([p]);
    expect((await store.get("licence-front"))?.data.equals(PNG)).toBe(true);
    for (const f of readdirSync(join(dir, "papers"))) {
      const path = join(dir, "papers", f);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path).includes(PNG.subarray(0, 8))).toBe(false);
      expect(readFileSync(path, "utf8")).not.toContain("drivers-licence");
    }
    expect(await store.remove("licence-front")).toBe(true);
    expect(readdirSync(join(dir, "papers"))).toEqual(["index.sealed"]);
    expect(await store.remove("licence-front")).toBe(false);
  });

  it("refuses bytes that are not the ones the record measured", async () => {
    const p = paperOf(PNG, { name: "a", kind: "passport" }, at);
    await expect(memoryPapers().put(p, PDF)).rejects.toThrow(/not the ones/);
  });

  it("a paper as an upload takes it: bytes in memory, named for its kind", () => {
    const p = paperOf(PDF, { name: "reg", kind: "business-registration" }, at);
    expect(paperPayload(p, PDF)).toEqual({
      name: "business-registration.pdf",
      mimeType: "application/pdf",
      buffer: PDF,
    });
  });
});

describe("the backup", () => {
  function memoryBucket(): PaperBucket & { objects: Map<string, { data: Buffer; meta: string }> } {
    const objects = new Map<string, { data: Buffer; meta: string }>();
    return {
      objects,
      put: async (k, data, meta) => void objects.set(k, { data, meta }),
      get: async (k) => objects.get(k) ?? null,
      keys: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)),
      remove: async (k) => void objects.delete(k),
    };
  }

  it("writes the Mac first, then the bucket; restores from the bucket", async () => {
    const bucket = memoryBucket();
    const cipher = aesGcmCipher(randomBytes(32));
    const store = backedUpPapers(filePapers(join(dir, "a"), cipher), bucketPapers(bucket));
    const p = paperOf(PNG, { name: "licence-front", kind: "drivers-licence" }, at);
    await store.put(p, PNG);
    expect([...bucket.objects.keys()]).toEqual(["papers/licence-front"]);
    const fresh = backedUpPapers(filePapers(join(dir, "b"), cipher), bucketPapers(bucket));
    expect(await fresh.restore()).toEqual(["licence-front"]);
    expect((await fresh.get("licence-front"))?.data.equals(PNG)).toBe(true);
    expect(await store.remove("licence-front")).toBe(true);
    expect(bucket.objects.size).toBe(0);
  });

  it("a failed backup keeps the Mac's copy and says how to retry", async () => {
    const broken = { ...memoryBucket(), put: async () => Promise.reject(new Error("expired")) };
    const local = memoryPapers();
    const store = backedUpPapers(local, bucketPapers(broken));
    const p = paperOf(PNG, { name: "a", kind: "passport" }, at);
    await expect(store.put(p, PNG)).rejects.toThrow(/papers backup/);
    expect(await local.list()).toHaveLength(1);
  });
});

describe("a drop from a phone", () => {
  it("mints signed, then opens what the page sealed under the fragment's key", async () => {
    const sent: { url: string; sig: string | null; body: string }[] = [];
    let filled: { iv: string; data: string } | null = null;
    const post = (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        sig: new Headers(init.headers).get(LINK_SIGNATURE),
        body: String(init.body),
      });
      if (url.endsWith("/drops")) return Response.json({ id: "AAAAAAAAAAAAAAAAAAAAAA" });
      return Response.json(filled ?? { waiting: true });
    }) as typeof fetch;
    const drop = await mintDrop("https://phone.test/", "s3cret", "drivers-licence front", {}, post);
    expect(drop.link).toBe(
      `https://phone.test/u/AAAAAAAAAAAAAAAAAAAAAA#${drop.key.toString("base64url")}`,
    );
    expect(sent[0]?.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sent[0]?.body).not.toContain(drop.key.toString("base64url"));
    expect(await takeDrop("https://phone.test", "s3cret", drop, post)).toBeNull();
    // As the page seals it: AES-GCM, the tag on the end.
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", drop.key, iv);
    const data = Buffer.concat([c.update(PNG), c.final(), c.getAuthTag()]);
    filled = { iv: iv.toString("base64"), data: data.toString("base64") };
    expect((await takeDrop("https://phone.test", "s3cret", drop, post))?.equals(PNG)).toBe(true);
    expect(sent.at(-1)?.url).toBe("https://phone.test/drops/AAAAAAAAAAAAAAAAAAAAAA/take");
    const wrongKey = { ...drop, key: randomBytes(32) };
    await expect(takeDrop("https://phone.test", "s3cret", wrongKey, post)).rejects.toThrow();
  });
});
