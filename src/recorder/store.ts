/** Recordings on disk: one directory each under RECORDINGS_DIR, a manifest plus files. */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MANIFEST, type Recording } from "./types.js";

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export function recordingDir(root: string, name: string): string {
  if (!NAME.test(name)) throw new Error(`recording name must be kebab-case, got ${name}`);
  return join(root, name);
}

export async function saveRecording(root: string, rec: Recording): Promise<string> {
  const dir = recordingDir(root, rec.name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, MANIFEST), `${JSON.stringify(rec, null, 2)}\n`);
  return dir;
}

export async function loadRecording(root: string, name: string): Promise<Recording> {
  const file = join(recordingDir(root, name), MANIFEST);
  return JSON.parse(await readFile(file, "utf8")) as Recording;
}

export async function listRecordings(root: string): Promise<Recording[]> {
  if (!existsSync(root)) return [];
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && NAME.test(d.name))
    .map((d) => d.name);
  const out: Recording[] = [];
  for (const n of names) {
    try {
      out.push(await loadRecording(root, n));
    } catch {
      // a directory without a manifest is a recording in progress
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
