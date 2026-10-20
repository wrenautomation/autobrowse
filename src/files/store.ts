/**
 * Files: one sealed store for what a form takes (designs/2026-10-20-files.md), kept like the
 * wallet:
 *
 * - Sealed on this Mac under the wallet's keychain key: one sealed index (records and named
 *   sets), one sealed file each.
 * - Backed up to the S3 bucket only William's AWS user may touch (deploy/terraform papers.tf).
 * - Each file is a `paper` (an ID document: a person says yes once per file and host before it
 *   lands, its text is never kept) or a `doc` (a resume, a transcript: no yes, its text read
 *   once at add time and sealed with it). Every use is audited.
 * - Nothing prints a file's bytes. Listings say name, kind, type, size and note.
 * - A file reaches a page only through explore's `upload{files:["file:<name>"]}`, from memory;
 *   no plaintext file is ever written.
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
import { textOf } from "./text.js";

export const FILE_KINDS = ["paper", "doc"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** Which ID document a paper is. */
export const PAPER_IDS = [
  "drivers-licence",
  "passport",
  "id-card",
  "business-registration",
  "utility-bill",
  "bank-statement",
  "other",
] as const;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** What a form takes, and the extension an upload names it with; anything else is refused at the door. */
export const FILE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/webp": "webp",
  "application/pdf": "pdf",
  [DOCX]: "docx",
  "text/plain": "txt",
  "text/markdown": "md",
} as const;
export type FileType = keyof typeof FILE_TYPES;

/** A paper is a photo or a scan: never a Word file or text. */
export const PAPER_TYPES: readonly FileType[] = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
  "application/pdf",
];

/** A phone photo is 2 to 6 MB; a scan as PDF rarely more. */
export const FILE_MAX_BYTES = 12 * 1024 * 1024;

const nameSchema = z.string().regex(/^[a-z0-9-]{1,64}$/, "name: lowercase letters, digits, dashes");

export const fileSchema = z
  .object({
    name: nameSchema,
    kind: z.enum(FILE_KINDS),
    /** A paper's ID type. */
    id: z.enum(PAPER_IDS).optional(),
    /** A paper's side. */
    side: z.enum(["front", "back", "whole"]).optional(),
    /** One line for the agent: what it is. */
    note: z.string().min(1).max(200),
    /** The profile it belongs to (`autobrowse profile`); absent: the only profile. */
    owner: z.string().optional(),
    type: z.enum(Object.keys(FILE_TYPES) as [FileType, ...FileType[]]),
    bytes: z.number().int().min(1).max(FILE_MAX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** A doc's words, read once at add time. Never on a paper. */
    text: z.string().optional(),
    /** When the document itself expires (a licence's date), YYYY-MM-DD. */
    expires: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    addedAt: z.string(),
  })
  .superRefine((f, ctx) => {
    if (f.kind === "paper" && !f.id)
      ctx.addIssue({ code: "custom", message: `${f.name}: a paper needs its id (passport, …)` });
    if (f.kind === "paper" && f.text !== undefined)
      ctx.addIssue({ code: "custom", message: `${f.name}: a paper's text is never kept` });
    if (f.kind === "doc" && (f.id || f.side))
      ctx.addIssue({ code: "custom", message: `${f.name}: id and side are for papers` });
    if (f.kind === "paper" && !PAPER_TYPES.includes(f.type))
      ctx.addIssue({ code: "custom", message: `${f.name}: a paper is a photo or a PDF` });
  });
export type FileRecord = z.infer<typeof fileSchema>;

/** Named sets: set name to file names. */
export type FileSets = Record<string, string[]>;

/** The type from the bytes themselves; a name's extension only tells Markdown from plain text. */
export function sniffType(b: Buffer, filename?: string): FileType | null {
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
  // A Word file is a zip whose entries name word/document.xml (names are stored uncompressed).
  if (
    b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
    b.includes("word/document.xml", 0, "latin1")
  )
    return DOCX;
  if (b.length && !b.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(b);
      return /\.(md|markdown)$/i.test(filename ?? "") ? "text/markdown" : "text/plain";
    } catch {
      return null;
    }
  }
  return null;
}

/** What `fileOf` is told; the rest it measures. */
export type FileMeta = Pick<FileRecord, "name"> &
  Partial<Pick<FileRecord, "id" | "side" | "owner" | "expires" | "note">> & {
    kind: FileKind;
    /** The original's name: only tells Markdown from plain text. */
    filename?: string;
  };

/** A file's record from its bytes: type sniffed, size and digest measured, a doc's text read. */
export async function fileOf(data: Buffer, meta: FileMeta, now = new Date()): Promise<FileRecord> {
  const { filename, ...rest } = meta;
  const type = sniffType(data, filename);
  if (!type) throw new Error(`${meta.name}: not a JPEG, PNG, HEIC, WebP, PDF, DOCX or text file`);
  if (data.length > FILE_MAX_BYTES)
    throw new Error(`${meta.name}: ${data.length} bytes, over ${FILE_MAX_BYTES}`);
  if (meta.kind === "paper" && !PAPER_TYPES.includes(type))
    throw new Error(`${meta.name}: a paper is a photo or a PDF (JPEG, PNG, HEIC, WebP, PDF)`);
  const text = meta.kind === "doc" ? await textOf(type, data) : null;
  const side = meta.kind === "paper" ? (meta.side ?? "whole") : undefined;
  return fileSchema.parse({
    ...rest,
    ...(side ? { side } : {}),
    note: meta.note ?? (meta.kind === "paper" ? paperLabel(meta.id, side) : meta.name),
    type,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    ...(text ? { text } : {}),
    addedAt: now.toISOString(),
  });
}

/** `drivers-licence front`, `passport`. */
export function paperLabel(id: string | undefined, side: string | undefined): string {
  return `${id ?? "paper"}${side && side !== "whole" ? ` ${side}` : ""}`;
}

const sizeOf = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/** One line, never the bytes or the text: `resume: doc, pdf 120 KB, 3400 chars; my resume`. */
export function describeFile(f: FileRecord): string {
  const what =
    f.kind === "paper"
      ? `paper ${paperLabel(f.id, f.side)}`
      : `doc${f.text ? `, ${f.text.length} chars` : ", no text"}`;
  return `${f.name}: ${what}, ${FILE_TYPES[f.type]} ${sizeOf(f.bytes)}${f.expires ? `, expires ${f.expires}` : ""}${f.owner ? `, ${f.owner}` : ""}; ${f.note}`;
}

/** A file as an agent sees it in a listing: no bytes, no text. */
export interface FileLine {
  name: string;
  kind: FileKind;
  type: string;
  size: string;
  note: string;
}
export const fileLine = (f: FileRecord): FileLine => ({
  name: f.name,
  kind: f.kind,
  type: FILE_TYPES[f.type],
  size: sizeOf(f.bytes),
  note: f.note,
});

export interface FileStore {
  list(): Promise<FileRecord[]>;
  get(name: string): Promise<{ file: FileRecord; data: Buffer } | null>;
  put(file: FileRecord, data: Buffer): Promise<unknown>;
  /** Drops the file and its place in every set. */
  remove(name: string): Promise<boolean>;
  sets(): Promise<FileSets>;
  /** Replaces a set's files (each must exist); null removes the set. */
  setSet(set: string, names: string[] | null): Promise<unknown>;
}

/** Checked before any write: the bytes are the ones the record measured. */
function check(file: FileRecord, data: Buffer): FileRecord {
  const f = fileSchema.parse(file);
  if (createHash("sha256").update(data).digest("hex") !== f.sha256)
    throw new Error(`${f.name}: the bytes are not the ones its record measured`);
  return f;
}

/** A set's new members, checked against the files there are. */
function checkSet(set: string, names: string[], files: FileRecord[]): string[] {
  nameSchema.parse(set);
  const have = new Set(files.map((f) => f.name));
  const missing = names.filter((n) => !have.has(n));
  if (missing.length) throw new Error(`no file ${missing.join(", ")} (autobrowse files list)`);
  return [...new Set(names)];
}

const withoutFile = (sets: FileSets, name: string): FileSets =>
  Object.fromEntries(Object.entries(sets).map(([s, ns]) => [s, ns.filter((n) => n !== name)]));

export function memoryFiles(): FileStore {
  const all = new Map<string, { file: FileRecord; data: Buffer }>();
  let sets: FileSets = {};
  return {
    list: async () => [...all.values()].map((e) => e.file),
    get: async (n) => all.get(n) ?? null,
    put: async (file, data) => void all.set(file.name, { file: check(file, data), data }),
    async remove(n) {
      sets = withoutFile(sets, n);
      return all.delete(n);
    },
    sets: async () => structuredClone(sets),
    async setSet(set, names) {
      if (names === null) {
        delete sets[nameSchema.parse(set)];
        return;
      }
      sets[set] = checkSet(
        set,
        names,
        [...all.values()].map((e) => e.file),
      );
    },
  };
}

const indexSchema = z.object({
  files: z.array(fileSchema),
  sets: z.record(z.string(), z.array(z.string())),
});
type Index = z.infer<typeof indexSchema>;

/**
 * The sealed copy: `<dir>/index.sealed` (records and sets) and `<dir>/<name>.sealed` (each
 * file, base64 under the cipher). 0700 dir, 0600 files, written through a rename.
 */
export function fileStore(dir: string, cipher: Cipher): FileStore {
  const index = join(dir, "index.sealed");
  const fileOf_ = (n: string) => join(dir, `${nameSchema.parse(n)}.sealed`);
  const seal = (path: string, text: string) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, cipher.seal(text), { mode: 0o600 });
    renameSync(tmp, path);
  };
  const read = (): Index =>
    existsSync(index)
      ? indexSchema.parse(JSON.parse(cipher.open(readFileSync(index, "utf8"))))
      : { files: [], sets: {} };
  const write = (i: Index) => seal(index, JSON.stringify(i));
  return {
    list: async () => read().files,
    async get(n) {
      const file = read().files.find((f) => f.name === n);
      if (!file || !existsSync(fileOf_(n))) return null;
      return { file, data: Buffer.from(cipher.open(readFileSync(fileOf_(n), "utf8")), "base64") };
    },
    async put(file, data) {
      const f = check(file, data);
      seal(fileOf_(f.name), data.toString("base64"));
      const i = read();
      write({ ...i, files: [...i.files.filter((x) => x.name !== f.name), f] });
    },
    async remove(n) {
      const i = read();
      const left = i.files.filter((f) => f.name !== n);
      if (left.length === i.files.length) return false;
      write({ files: left, sets: withoutFile(i.sets, n) });
      if (existsSync(fileOf_(n))) unlinkSync(fileOf_(n));
      return true;
    },
    sets: async () => read().sets,
    async setSet(set, names) {
      const i = read();
      const sets = { ...i.sets };
      if (names === null) delete sets[nameSchema.parse(set)];
      else sets[set] = checkSet(set, names, i.files);
      write({ ...i, sets });
    },
  };
}

/** The S3 calls the backup makes; `s3FileBucket` in shots/s3.ts wraps the SDK. */
export interface FileBucket {
  put(key: string, data: Buffer, meta: string): Promise<unknown>;
  get(key: string): Promise<{ data: Buffer; meta: string } | null>;
  keys(prefix: string): Promise<string[]>;
  remove(key: string): Promise<unknown>;
}

/**
 * The backup: one object per file under `<prefix>/`, its record (less a doc's text: S3
 * metadata holds 2 KB) in the object's metadata; the text is read again from the bytes on
 * the way back. The sets are one object beside them, `<prefix>.sets`.
 */
export function bucketFiles(bucket: FileBucket, prefix = "files"): FileStore {
  const keyOf = (n: string) => `${prefix}/${nameSchema.parse(n)}`;
  const setsKey = `${prefix}.sets`;
  const recordOf = (meta: string) =>
    fileSchema.parse(JSON.parse(Buffer.from(meta, "base64url").toString("utf8")));
  const get = async (n: string) => {
    const got = await bucket.get(keyOf(n));
    if (!got) return null;
    const file = recordOf(got.meta);
    const text = file.kind === "doc" ? await textOf(file.type, got.data) : null;
    return { file: text ? { ...file, text } : file, data: got.data };
  };
  const sets = async (): Promise<FileSets> => {
    const got = await bucket.get(setsKey);
    return got ? indexSchema.shape.sets.parse(JSON.parse(got.data.toString("utf8"))) : {};
  };
  const putSets = (s: FileSets) => bucket.put(setsKey, Buffer.from(JSON.stringify(s)), "sets");
  const records = async () => {
    const out: FileRecord[] = [];
    for (const k of await bucket.keys(`${prefix}/`)) {
      const got = await bucket.get(k);
      if (got) out.push(recordOf(got.meta));
    }
    return out;
  };
  return {
    list: records,
    get,
    put: async (file, data) => {
      const { text: _, ...f } = check(file, data);
      await bucket.put(keyOf(f.name), data, Buffer.from(JSON.stringify(f)).toString("base64url"));
    },
    async remove(n) {
      const had = (await bucket.get(keyOf(n))) !== null;
      await bucket.remove(keyOf(n));
      const s = await sets();
      if (Object.values(s).some((ns) => ns.includes(n))) await putSets(withoutFile(s, n));
      return had;
    },
    sets,
    async setSet(set, names) {
      const s = await sets();
      if (names === null) delete s[nameSchema.parse(set)];
      else s[set] = checkSet(set, names, await records());
      await putSets(s);
    },
  };
}

/** The Mac's copy first, the bucket on every change; a failed backup says how to retry. */
export function backedUpFiles(local: FileStore, backup: FileStore) {
  const also = async (what: string, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (err) {
      throw new Error(
        `${what}: changed on this Mac, but its backup failed (autobrowse aws-login, then autobrowse files backup): ${(err as Error).name}`,
      );
    }
  };
  const putSets = async () => {
    const s = await local.sets();
    for (const [set, names] of Object.entries(s)) await backup.setSet(set, names);
    for (const set of Object.keys(await backup.sets()))
      if (!(set in s)) await backup.setSet(set, null);
  };
  return {
    list: local.list,
    get: local.get,
    sets: local.sets,
    async put(file: FileRecord, data: Buffer) {
      await local.put(file, data);
      await also(file.name, () => backup.put(file, data));
    },
    async remove(n: string) {
      const had = await local.remove(n);
      await also(n, () => backup.remove(n));
      return had;
    },
    async setSet(set: string, names: string[] | null) {
      await local.setSet(set, names);
      await also(`set ${set}`, () => backup.setSet(set, names));
    },
    /** Every backed-up file and set into this Mac's copy; the names restored. */
    async restore() {
      const names: string[] = [];
      for (const f of await backup.list()) {
        const got = await backup.get(f.name);
        if (!got) continue;
        await local.put(got.file, got.data);
        names.push(f.name);
      }
      const have = new Set((await local.list()).map((f) => f.name));
      for (const [set, members] of Object.entries(await backup.sets()))
        await local.setSet(
          set,
          members.filter((n) => have.has(n)),
        );
      return names;
    },
    /** Every file and set on this Mac to the bucket again: after a backup that failed. */
    async backup() {
      const names: string[] = [];
      for (const f of await local.list()) {
        const got = await local.get(f.name);
        if (!got) continue;
        await backup.put(got.file, got.data);
        names.push(f.name);
      }
      await putSets();
      return names;
    },
  };
}

/** `file:<name>` in an upload's files names a stored file; anything else is a path. */
export function fileRef(file: string): string | null {
  const m = /^file:([a-z0-9-]{1,64})$/.exec(file);
  return m?.[1] ?? null;
}

/**
 * A file as an upload takes it: bytes in memory. A paper is named for its id and side, a doc
 * for itself (forms check the extension). Playwright hands them to the page; no file is written.
 */
export function filePayload(
  file: FileRecord,
  data: Buffer,
): { name: string; mimeType: string; buffer: Buffer } {
  const base =
    file.kind === "paper"
      ? `${file.id}${file.side && file.side !== "whole" ? `-${file.side}` : ""}`
      : file.name;
  return { name: `${base}.${FILE_TYPES[file.type]}`, mimeType: file.type, buffer: data };
}

/** The files in these sets, in set order, each once; an unknown set is an error. */
export async function filesInSets(
  store: Pick<FileStore, "list" | "sets">,
  names: string[],
): Promise<FileRecord[]> {
  const [files, sets] = await Promise.all([store.list(), store.sets()]);
  const out: FileRecord[] = [];
  for (const s of names) {
    const members = sets[s];
    if (!members)
      throw new Error(
        `no file set ${s} (autobrowse files sets: ${Object.keys(sets).join(", ") || "none"})`,
      );
    for (const n of members) {
      const f = files.find((x) => x.name === n);
      if (f && !out.includes(f)) out.push(f);
    }
  }
  return out;
}
