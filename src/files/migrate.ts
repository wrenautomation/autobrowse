/**
 * Papers into files, once (designs/2026-10-20-files.md): every paper in the old sealed dir is
 * copied into the files store as kind `paper`, then each copy is read back, opened and
 * compared byte for byte with the original. Only when every one matches does the old dir move
 * to a `papers-retired` sibling. Nothing is deleted; a failed check leaves the old dir where
 * it was.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Cipher } from "credvault";
import { z } from "zod";
import { type FileStore, fileSchema, PAPER_IDS, PAPER_TYPES, paperLabel } from "./store.js";

/** The record `autobrowse papers` wrote (designs/2026-10-12-papers.md). */
const legacyPaper = z.object({
  name: z.string().regex(/^[a-z0-9-]{1,64}$/),
  kind: z.enum(PAPER_IDS),
  side: z.enum(["front", "back", "whole"]).default("whole"),
  owner: z.string().optional(),
  type: z.enum(PAPER_TYPES as [string, ...string[]]),
  bytes: z.number().int().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  expires: z.string().optional(),
  addedAt: z.string(),
});

export interface Migrated {
  /** Papers in the old index. */
  total: number;
  /** Copied now. */
  copied: number;
  /** Already in the files store with the same bytes (a second run). */
  already: number;
  /** Sealed files in the old dir the index did not name (kept in the retired dir). */
  unindexed: number;
  /** Where the old dir went; null when there was none. */
  retiredTo: string | null;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Where the old dir goes: `<parent>/papers-retired`, or with a stamp when that is taken. */
export function retiredDirFor(from: string, now = new Date()): string {
  const base = join(dirname(from), `${basename(from)}-retired`);
  return existsSync(base) ? `${base}-${now.toISOString().replace(/[:.]/g, "-")}` : base;
}

export async function migratePapers(o: {
  from: string;
  cipher: Cipher;
  to: Pick<FileStore, "get" | "put">;
  now?: Date;
}): Promise<Migrated> {
  const index = join(o.from, "index.sealed");
  if (!existsSync(o.from))
    return { total: 0, copied: 0, already: 0, unindexed: 0, retiredTo: null };
  if (!existsSync(index))
    throw new Error(`${o.from} has no index.sealed: nothing moved, look at it by hand`);
  const papers = z.array(legacyPaper).parse(JSON.parse(o.cipher.open(readFileSync(index, "utf8"))));
  const originals = new Map<string, Buffer>();
  for (const p of papers) {
    const path = join(o.from, `${p.name}.sealed`);
    if (!existsSync(path))
      throw new Error(`${p.name}: in the index, no sealed file: nothing moved`);
    const data = Buffer.from(o.cipher.open(readFileSync(path, "utf8")), "base64");
    if (sha(data) !== p.sha256 || data.length !== p.bytes)
      throw new Error(`${p.name}: its bytes do not match its record: nothing moved`);
    originals.set(p.name, data);
  }
  let copied = 0;
  let already = 0;
  for (const p of papers) {
    const data = originals.get(p.name) as Buffer;
    const there = await o.to.get(p.name);
    if (there) {
      if (there.file.sha256 !== p.sha256 || there.file.kind !== "paper")
        throw new Error(
          `${p.name}: a different file has that name in the files store: nothing moved`,
        );
      already++;
      continue;
    }
    const file = fileSchema.parse({
      name: p.name,
      kind: "paper",
      id: p.kind,
      side: p.side,
      note: paperLabel(p.kind, p.side),
      ...(p.owner ? { owner: p.owner } : {}),
      type: p.type,
      bytes: p.bytes,
      sha256: p.sha256,
      ...(p.expires ? { expires: p.expires } : {}),
      addedAt: p.addedAt,
    });
    await o.to.put(file, data);
    copied++;
  }
  // Read every copy back through the store (opened under the cipher) and compare.
  for (const p of papers) {
    const got = await o.to.get(p.name);
    const was = originals.get(p.name) as Buffer;
    if (!got || got.file.sha256 !== p.sha256 || sha(got.data) !== p.sha256 || !got.data.equals(was))
      throw new Error(`${p.name}: its copy does not read back the same: old dir left in place`);
  }
  const named = new Set(papers.map((p) => `${p.name}.sealed`));
  const unindexed = readdirSync(o.from).filter(
    (f) => f.endsWith(".sealed") && f !== "index.sealed" && !named.has(f),
  ).length;
  const retiredTo = retiredDirFor(o.from, o.now);
  renameSync(o.from, retiredTo);
  return { total: papers.length, copied, already, unindexed, retiredTo };
}
