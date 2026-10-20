/** Files: sealed on disk, backed up to a bucket, a doc's text read at add time, papers moved in once. */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { aesGcmCipher, type Cipher } from "credvault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LINK_SIGNATURE, mintDrop, takeDrop } from "../src/auth/link.js";
import { migratePapers, retiredDirFor } from "../src/files/migrate.js";
import {
  backedUpFiles,
  bucketFiles,
  describeFile,
  FILE_MAX_BYTES,
  type FileBucket,
  fileLine,
  fileOf,
  filePayload,
  fileRef,
  fileStore,
  filesInSets,
  memoryFiles,
  sniffType,
} from "../src/files/store.js";

/** A 1x1 PNG: synthetic. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const at = new Date("2026-10-20T12:00:00Z");

/** A one-page PDF that says `text`, offsets measured so a real reader opens it. */
function pdfOf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A zip of stored (uncompressed) entries. */
function zipOf(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(entries)) {
    const data = Buffer.from(body);
    const n = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** A Word file with one paragraph per line. */
function docxOf(lines: string[]): Buffer {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  return zipOf({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${lines
      .map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`)
      .join("")}</w:body></w:document>`,
  });
}

const PDF = pdfOf("Synthetic Person, Example University transcript");
const DOCX = docxOf(["Synthetic Person", "Worked at Example Co"]);
const MD = Buffer.from("# Work history\n\n- Example Co, 2024 to 2026\n");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "files-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a file's record", () => {
  it("takes its type from the bytes; the name only tells Markdown from text", () => {
    expect(sniffType(PNG)).toBe("image/png");
    expect(sniffType(PDF)).toBe("application/pdf");
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffType(DOCX)).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(sniffType(zipOf({ "a.txt": "x" }))).toBeNull();
    expect(sniffType(MD, "history.md")).toBe("text/markdown");
    expect(sniffType(MD, "history.txt")).toBe("text/plain");
    expect(sniffType(MD)).toBe("text/plain");
    expect(sniffType(Buffer.from([0xc3, 0x28]))).toBeNull();
    expect(sniffType(Buffer.from([0x41, 0, 0x42]))).toBeNull();
  });

  it("reads a doc's text at add time: PDF, DOCX, Markdown; an image has none", async () => {
    const pdf = await fileOf(PDF, { name: "transcript", kind: "doc", note: "my transcript" }, at);
    expect(pdf).toMatchObject({ kind: "doc", type: "application/pdf", note: "my transcript" });
    expect(pdf.text).toContain("Example University transcript");
    const docx = await fileOf(DOCX, { name: "resume", kind: "doc", note: "my resume" }, at);
    expect(docx.text).toBe("Synthetic Person\n\nWorked at Example Co");
    const md = await fileOf(MD, { name: "history", kind: "doc", filename: "h.md" }, at);
    expect(md).toMatchObject({ type: "text/markdown", note: "history" });
    expect(md.text).toBe("# Work history\n\n- Example Co, 2024 to 2026");
    const photo = await fileOf(PNG, { name: "headshot", kind: "doc", note: "a photo" }, at);
    expect(photo.text).toBeUndefined();
    expect(describeFile(docx)).toBe(
      `resume: doc, ${docx.text?.length} chars, docx ${Math.round(DOCX.length / 1024)} KB; my resume`,
    );
    expect(describeFile(photo)).toBe("headshot: doc, no text, png 0 KB; a photo");
  });

  it("a paper keeps no text, is a photo or a PDF, and says what it is", async () => {
    const p = await fileOf(PDF, { name: "licence", kind: "paper", id: "drivers-licence" }, at);
    expect(p).toMatchObject({ kind: "paper", side: "whole", note: "drivers-licence" });
    expect(p.text).toBeUndefined();
    const front = await fileOf(
      PNG,
      { name: "licence-front", kind: "paper", id: "drivers-licence", side: "front" },
      at,
    );
    expect(describeFile(front)).toBe(
      "licence-front: paper drivers-licence front, png 0 KB; drivers-licence front",
    );
    expect(fileLine(front)).toEqual({
      name: "licence-front",
      kind: "paper",
      type: "png",
      size: "0 KB",
      note: "drivers-licence front",
    });
    await expect(fileOf(DOCX, { name: "x", kind: "paper", id: "passport" })).rejects.toThrow(
      /a photo or a PDF/,
    );
    await expect(fileOf(PNG, { name: "x", kind: "paper" })).rejects.toThrow(/needs its id/);
    await expect(
      fileOf(PNG, { name: "x", kind: "doc", note: "n", id: "passport" }),
    ).rejects.toThrow(/id and side are for papers/);
  });

  it("refuses what no form takes, a bad name, and anything over 12 MB", async () => {
    await expect(
      fileOf(Buffer.from([0x00, 0x01]), { name: "x", kind: "doc", note: "n" }),
    ).rejects.toThrow(/not a JPEG/);
    await expect(fileOf(MD, { name: "Bad Name", kind: "doc", note: "n" })).rejects.toThrow(
      /lowercase/,
    );
    const big = Buffer.concat([PNG, Buffer.alloc(FILE_MAX_BYTES)]);
    await expect(fileOf(big, { name: "big", kind: "doc", note: "n" })).rejects.toThrow(/over/);
  });

  it("names a stored file in an upload as file:<name>, and as the page receives it", async () => {
    expect(fileRef("file:resume")).toBe("resume");
    expect(fileRef("paper:licence-front")).toBeNull();
    expect(fileRef("/tmp/a.png")).toBeNull();
    expect(fileRef("file:../etc")).toBeNull();
    const reg = await fileOf(PDF, { name: "reg", kind: "paper", id: "business-registration" });
    expect(filePayload(reg, PDF)).toEqual({
      name: "business-registration.pdf",
      mimeType: "application/pdf",
      buffer: PDF,
    });
    const resume = await fileOf(DOCX, { name: "resume", kind: "doc", note: "n" });
    expect(filePayload(resume, DOCX).name).toBe("resume.docx");
  });
});

describe("the sealed copy", () => {
  it("round-trips sealed, 0600, with neither bytes nor text readable on disk", async () => {
    const store = fileStore(join(dir, "files"), aesGcmCipher(randomBytes(32)));
    const f = await fileOf(DOCX, { name: "resume", kind: "doc", note: "my resume" }, at);
    await store.put(f, DOCX);
    expect(await store.list()).toEqual([f]);
    expect((await store.get("resume"))?.data.equals(DOCX)).toBe(true);
    for (const name of readdirSync(join(dir, "files"))) {
      const path = join(dir, "files", name);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path).includes(DOCX.subarray(0, 8))).toBe(false);
      expect(readFileSync(path, "utf8")).not.toContain("Example Co");
    }
    expect(await store.remove("resume")).toBe(true);
    expect(readdirSync(join(dir, "files"))).toEqual(["index.sealed"]);
    expect(await store.remove("resume")).toBe(false);
  });

  it("refuses bytes that are not the ones the record measured", async () => {
    const f = await fileOf(PNG, { name: "a", kind: "paper", id: "passport" }, at);
    await expect(memoryFiles().put(f, PDF)).rejects.toThrow(/not the ones/);
  });

  it("names sets of stored files; a removed file leaves every set", async () => {
    for (const store of [memoryFiles(), fileStore(join(dir, "s"), aesGcmCipher(randomBytes(32)))]) {
      await store.put(await fileOf(DOCX, { name: "resume", kind: "doc", note: "r" }, at), DOCX);
      await store.put(await fileOf(PDF, { name: "transcript", kind: "doc", note: "t" }, at), PDF);
      await store.put(await fileOf(MD, { name: "history", kind: "doc", note: "h" }, at), MD);
      await store.setSet("coop", ["resume", "transcript", "resume"]);
      await store.setSet("long", ["history", "resume"]);
      expect(await store.sets()).toEqual({
        coop: ["resume", "transcript"],
        long: ["history", "resume"],
      });
      await expect(store.setSet("coop", ["resume", "nope"])).rejects.toThrow(/no file nope/);
      expect((await filesInSets(store, ["long", "coop"])).map((f) => f.name)).toEqual([
        "history",
        "resume",
        "transcript",
      ]);
      await expect(filesInSets(store, ["gone"])).rejects.toThrow(/no file set gone/);
      await store.setSet("coop", ["transcript"]);
      await store.remove("resume");
      expect(await store.sets()).toEqual({ coop: ["transcript"], long: ["history"] });
      await store.setSet("long", null);
      expect(Object.keys(await store.sets())).toEqual(["coop"]);
    }
  });
});

describe("the backup", () => {
  function memoryBucket(): FileBucket & { objects: Map<string, { data: Buffer; meta: string }> } {
    const objects = new Map<string, { data: Buffer; meta: string }>();
    return {
      objects,
      put: async (k, data, meta) => void objects.set(k, { data, meta }),
      get: async (k) => objects.get(k) ?? null,
      keys: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)),
      remove: async (k) => void objects.delete(k),
    };
  }

  it("writes the Mac first, then the bucket, text left out; restores files and sets", async () => {
    const bucket = memoryBucket();
    const cipher = aesGcmCipher(randomBytes(32));
    const store = backedUpFiles(fileStore(join(dir, "a"), cipher), bucketFiles(bucket));
    const resume = await fileOf(DOCX, { name: "resume", kind: "doc", note: "my resume" }, at);
    const licence = await fileOf(PNG, { name: "licence", kind: "paper", id: "passport" }, at);
    await store.put(resume, DOCX);
    await store.put(licence, PNG);
    await store.setSet("coop", ["resume", "licence"]);
    expect([...bucket.objects.keys()].sort()).toEqual([
      "files.sets",
      "files/licence",
      "files/resume",
    ]);
    const meta = bucket.objects.get("files/resume")?.meta ?? "";
    expect(Buffer.from(meta, "base64url").toString("utf8")).not.toContain("Example Co");
    const fresh = backedUpFiles(fileStore(join(dir, "b"), cipher), bucketFiles(bucket));
    expect((await fresh.restore()).sort()).toEqual(["licence", "resume"]);
    const back = await fresh.get("resume");
    expect(back?.data.equals(DOCX)).toBe(true);
    expect(back?.file.text).toBe(resume.text);
    expect(await fresh.sets()).toEqual({ coop: ["resume", "licence"] });
    await store.setSet("coop", null);
    expect(bucket.objects.has("files.sets") && (await bucketFiles(bucket).sets())).toEqual({});
    expect(await store.remove("resume")).toBe(true);
    expect(await store.remove("licence")).toBe(true);
    expect([...bucket.objects.keys()]).toEqual(["files.sets"]);
  });

  it("a failed backup keeps the Mac's copy and says how to retry", async () => {
    const broken = { ...memoryBucket(), put: async () => Promise.reject(new Error("expired")) };
    const local = memoryFiles();
    const store = backedUpFiles(local, bucketFiles(broken));
    const f = await fileOf(PNG, { name: "a", kind: "paper", id: "passport" }, at);
    await expect(store.put(f, PNG)).rejects.toThrow(/autobrowse files backup/);
    expect(await local.list()).toHaveLength(1);
  });
});

describe("papers into files", () => {
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  /** The old `autobrowse papers` dir: a sealed array index and one sealed base64 file each. */
  function legacyDir(
    cipher: Cipher,
    papers: Array<{ name: string; data: Buffer; kind: string; side?: string }>,
  ) {
    const from = join(dir, "papers");
    mkdirSync(from, { mode: 0o700 });
    const records = papers.map((p) => ({
      name: p.name,
      kind: p.kind,
      side: p.side ?? "whole",
      type: sniffType(p.data),
      bytes: p.data.length,
      sha256: sha(p.data),
      addedAt: at.toISOString(),
    }));
    writeFileSync(join(from, "index.sealed"), cipher.seal(JSON.stringify(records)));
    for (const p of papers)
      writeFileSync(join(from, `${p.name}.sealed`), cipher.seal(p.data.toString("base64")));
    return from;
  }

  it("copies each paper, reads it back, then moves the old dir aside: nothing deleted", async () => {
    const cipher = aesGcmCipher(randomBytes(32));
    const from = legacyDir(cipher, [
      { name: "licence-front", data: PNG, kind: "drivers-licence", side: "front" },
      { name: "reg", data: PDF, kind: "business-registration" },
    ]);
    const to = fileStore(join(dir, "files"), cipher);
    const r = await migratePapers({ from, cipher, to });
    expect(r).toEqual({
      total: 2,
      copied: 2,
      already: 0,
      unindexed: 0,
      retiredTo: join(dir, "papers-retired"),
    });
    expect(existsSync(from)).toBe(false);
    expect(readdirSync(join(dir, "papers-retired")).sort()).toEqual([
      "index.sealed",
      "licence-front.sealed",
      "reg.sealed",
    ]);
    const got = await to.get("licence-front");
    expect(got?.data.equals(PNG)).toBe(true);
    expect(got?.file).toMatchObject({
      kind: "paper",
      id: "drivers-licence",
      side: "front",
      note: "drivers-licence front",
      addedAt: at.toISOString(),
    });
    expect((await to.get("reg"))?.data.equals(PDF)).toBe(true);
    // A second run finds no old dir and changes nothing.
    expect(await migratePapers({ from, cipher, to })).toMatchObject({ total: 0, retiredTo: null });
  });

  it("an empty old index moves aside too; a taken papers-retired gets a stamp", async () => {
    const cipher = aesGcmCipher(randomBytes(32));
    mkdirSync(join(dir, "papers-retired"));
    const from = legacyDir(cipher, []);
    const now = new Date("2026-10-20T13:00:00Z");
    const r = await migratePapers({ from, cipher, to: memoryFiles(), now });
    expect(r.total).toBe(0);
    expect(r.retiredTo).toBe(retiredDirFor(from, now));
    expect(r.retiredTo).toBe(join(dir, "papers-retired-2026-10-20T13-00-00-000Z"));
    expect(readdirSync(r.retiredTo as string)).toEqual(["index.sealed"]);
  });

  it("a bad copy or a clash leaves the old dir where it was", async () => {
    const cipher = aesGcmCipher(randomBytes(32));
    const from = legacyDir(cipher, [{ name: "passport", data: PNG, kind: "passport" }]);
    // Bytes that are not the record's.
    writeFileSync(join(from, "passport.sealed"), cipher.seal(PDF.toString("base64")));
    await expect(migratePapers({ from, cipher, to: memoryFiles() })).rejects.toThrow(
      /do not match/,
    );
    expect(existsSync(join(from, "index.sealed"))).toBe(true);
    writeFileSync(join(from, "passport.sealed"), cipher.seal(PNG.toString("base64")));
    // A different file already has the name.
    const to = memoryFiles();
    await to.put(await fileOf(PDF, { name: "passport", kind: "doc", note: "n" }), PDF);
    await expect(migratePapers({ from, cipher, to })).rejects.toThrow(/different file/);
    // A store that loses what it was given.
    const lossy = { get: async () => null, put: async () => undefined };
    await expect(migratePapers({ from, cipher, to: lossy })).rejects.toThrow(/read back/);
    // The wrong key opens nothing.
    await expect(
      migratePapers({ from, cipher: aesGcmCipher(randomBytes(32)), to: memoryFiles() }),
    ).rejects.toThrow();
    expect(readdirSync(from).sort()).toEqual(["index.sealed", "passport.sealed"]);
    // The same paper already moved counts once and still moves the dir.
    const done = memoryFiles();
    await done.put(await fileOf(PNG, { name: "passport", kind: "paper", id: "passport" }), PNG);
    expect(await migratePapers({ from, cipher, to: done })).toMatchObject({
      total: 1,
      copied: 0,
      already: 1,
    });
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
