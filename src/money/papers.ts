/**
 * Papers: a person's identity documents for verification forms (a driver's licence, a passport,
 * a business registration). Kept like the wallet (designs/2026-10-12-papers.md):
 *
 * - Sealed on this Mac under the wallet's keychain key: one sealed index, one sealed file each.
 * - Backed up to an S3 bucket only William's AWS user may touch (deploy/terraform papers.tf):
 *   no machine role, Lambda or box reads it, whatever its own policy says.
 * - Nothing prints an image. Listings say kind, side, size and type.
 * - A paper reaches a page only through explore's `upload{files:["paper:<name>"]}`, after a
 *   person said yes to that paper on that host. Its bytes go to the page from memory; no
 *   plaintext file is ever written.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Cipher } from "credvault";
import { z } from "zod";

export const PAPER_KINDS = [
  "drivers-licence",
  "passport",
  "id-card",
  "business-registration",
  "utility-bill",
  "bank-statement",
  "other",
] as const;

/** What a form takes; anything else is refused at the door. */
export const PAPER_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/webp": "webp",
  "application/pdf": "pdf",
} as const;
export type PaperType = keyof typeof PAPER_TYPES;

/** A phone photo is 2 to 6 MB; a scan as PDF rarely more. */
export const PAPER_MAX_BYTES = 12 * 1024 * 1024;

export const paperSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]{1,64}$/, "name: lowercase letters, digits, dashes"),
  kind: z.enum(PAPER_KINDS),
  side: z.enum(["front", "back", "whole"]).default("whole"),
  /** The profile it belongs to (`autobrowse profile`); absent: the only profile. */
  owner: z.string().optional(),
  type: z.enum(Object.keys(PAPER_TYPES) as [PaperType, ...PaperType[]]),
  bytes: z.number().int().min(1).max(PAPER_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** When the document itself expires (a licence's date), YYYY-MM-DD. */
  expires: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  addedAt: z.string(),
});
export type Paper = z.infer<typeof paperSchema>;

/** The type from the bytes themselves; a name's extension is not trusted. */
export function sniffType(b: Buffer): PaperType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  if (
    b.subarray(4, 8).toString("latin1") === "ftyp" &&
    /^(heic|heix|mif1|msf1)$/.test(b.subarray(8, 12).toString("latin1"))
  )
    return "image/heic";
  return null;
}

/** A paper's record from its bytes: type sniffed, size and digest measured. */
export function paperOf(
  data: Buffer,
  meta: Pick<Paper, "name" | "kind"> & Partial<Pick<Paper, "side" | "owner" | "expires">>,
  now = new Date(),
): Paper {
  const type = sniffType(data);
  if (!type) throw new Error(`${meta.name}: not a JPEG, PNG, HEIC, WebP or PDF`);
  if (data.length > PAPER_MAX_BYTES)
    throw new Error(`${meta.name}: ${data.length} bytes, over ${PAPER_MAX_BYTES}`);
  return paperSchema.parse({
    ...meta,
    type,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    addedAt: now.toISOString(),
  });
}

export function describePaper(p: Paper): string {
  const side = p.side === "whole" ? "" : ` ${p.side}`;
  const kb = Math.round(p.bytes / 1024);
  return `${p.name}: ${p.kind}${side}, ${PAPER_TYPES[p.type]} ${kb} KB${p.expires ? `, expires ${p.expires}` : ""}${p.owner ? `, ${p.owner}` : ""}`;
}

export interface Papers {
  list(): Promise<Paper[]>;
  get(name: string): Promise<{ paper: Paper; data: Buffer } | null>;
  put(paper: Paper, data: Buffer): Promise<unknown>;
  remove(name: string): Promise<boolean>;
}

/** Checked before any write: the bytes are the ones the record measured. */
function check(paper: Paper, data: Buffer): Paper {
  const p = paperSchema.parse(paper);
  if (createHash("sha256").update(data).digest("hex") !== p.sha256)
    throw new Error(`${p.name}: the bytes are not the ones its record measured`);
  return p;
}

export function memoryPapers(): Papers {
  const all = new Map<string, { paper: Paper; data: Buffer }>();
  return {
    list: async () => [...all.values()].map((e) => e.paper),
    get: async (n) => all.get(n) ?? null,
    put: async (paper, data) => void all.set(paper.name, { paper: check(paper, data), data }),
    remove: async (n) => all.delete(n),
  };
}

/**
 * The sealed copy: `<dir>/index.sealed` (the records) and `<dir>/<name>.sealed` (each document,
 * base64 under the cipher). 0700 dir, 0600 files, written through a rename.
 */
export function filePapers(dir: string, cipher: Cipher): Papers {
  const index = join(dir, "index.sealed");
  const fileOf = (n: string) => join(dir, `${paperSchema.shape.name.parse(n)}.sealed`);
  const seal = (path: string, text: string) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, cipher.seal(text), { mode: 0o600 });
    renameSync(tmp, path);
  };
  const read = (): Paper[] =>
    existsSync(index)
      ? z.array(paperSchema).parse(JSON.parse(cipher.open(readFileSync(index, "utf8"))))
      : [];
  return {
    list: async () => read(),
    async get(n) {
      const paper = read().find((p) => p.name === n);
      if (!paper || !existsSync(fileOf(n))) return null;
      return { paper, data: Buffer.from(cipher.open(readFileSync(fileOf(n), "utf8")), "base64") };
    },
    async put(paper, data) {
      const p = check(paper, data);
      seal(fileOf(p.name), data.toString("base64"));
      seal(index, JSON.stringify([...read().filter((x) => x.name !== p.name), p]));
    },
    async remove(n) {
      const all = read();
      const left = all.filter((p) => p.name !== n);
      if (left.length === all.length) return false;
      seal(index, JSON.stringify(left));
      if (existsSync(fileOf(n))) unlinkSync(fileOf(n));
      return true;
    },
  };
}

/** The S3 calls the backup makes; `s3Papers` in services wraps the SDK. */
export interface PaperBucket {
  put(key: string, data: Buffer, meta: string): Promise<unknown>;
  get(key: string): Promise<{ data: Buffer; meta: string } | null>;
  keys(prefix: string): Promise<string[]>;
  remove(key: string): Promise<unknown>;
}

/** The backup: one object per paper under `<prefix>/`, its record in the object's metadata. */
export function bucketPapers(bucket: PaperBucket, prefix = "papers"): Papers {
  const keyOf = (n: string) => `${prefix}/${paperSchema.shape.name.parse(n)}`;
  const recordOf = (meta: string) =>
    paperSchema.parse(JSON.parse(Buffer.from(meta, "base64url").toString("utf8")));
  const get = async (n: string) => {
    const got = await bucket.get(keyOf(n));
    return got ? { paper: recordOf(got.meta), data: got.data } : null;
  };
  return {
    async list() {
      const out: Paper[] = [];
      for (const k of await bucket.keys(`${prefix}/`)) {
        const got = await get(k.slice(prefix.length + 1));
        if (got) out.push(got.paper);
      }
      return out;
    },
    get,
    put: async (paper, data) => {
      const p = check(paper, data);
      await bucket.put(keyOf(p.name), data, Buffer.from(JSON.stringify(p)).toString("base64url"));
    },
    async remove(n) {
      const had = (await bucket.get(keyOf(n))) !== null;
      await bucket.remove(keyOf(n));
      return had;
    },
  };
}

/** The Mac's copy first, the bucket on every change; a failed backup says how to retry. */
export function backedUpPapers(local: Papers, backup: Papers) {
  const also = async (what: string, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (err) {
      throw new Error(
        `${what}: changed on this Mac, but its backup failed (autobrowse aws-login, then autobrowse papers backup): ${(err as Error).name}`,
      );
    }
  };
  return {
    list: local.list,
    get: local.get,
    async put(paper: Paper, data: Buffer) {
      await local.put(paper, data);
      await also(paper.name, () => backup.put(paper, data));
    },
    async remove(n: string) {
      const had = await local.remove(n);
      await also(n, () => backup.remove(n));
      return had;
    },
    /** Every backed-up paper into this Mac's copy; the names restored. */
    async restore() {
      const names: string[] = [];
      for (const p of await backup.list()) {
        const got = await backup.get(p.name);
        if (!got) continue;
        await local.put(got.paper, got.data);
        names.push(p.name);
      }
      return names;
    },
    /** Every paper on this Mac to the bucket again: after a backup that failed. */
    async backup() {
      const names: string[] = [];
      for (const p of await local.list()) {
        const got = await local.get(p.name);
        if (!got) continue;
        await backup.put(got.paper, got.data);
        names.push(p.name);
      }
      return names;
    },
  };
}

/** `paper:<name>` in an upload's files names a paper; anything else is a path. */
export function paperRef(file: string): string | null {
  const m = /^paper:([a-z0-9-]{1,64})$/.exec(file);
  return m?.[1] ?? null;
}

/**
 * A paper as an upload takes it: bytes in memory, named for its kind and side (forms check the
 * extension). Playwright hands them to the page itself; no file is ever written.
 */
export function paperPayload(
  paper: Paper,
  data: Buffer,
): { name: string; mimeType: string; buffer: Buffer } {
  const side = paper.side === "whole" ? "" : `-${paper.side}`;
  return {
    name: `${paper.kind}${side}.${PAPER_TYPES[paper.type]}`,
    mimeType: paper.type,
    buffer: data,
  };
}
