/** Recordings on disk: one directory each under RECORDINGS_DIR, a manifest plus files. */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MANIFEST,
  type Recording,
  type RecordingSummary,
  SUMMARY,
  summarizeRecording,
} from "./types.js";

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export function recordingDir(root: string, name: string): string {
  if (!NAME.test(name)) throw new Error(`recording name must be kebab-case, got ${name}`);
  return join(root, name);
}

export async function saveRecording(root: string, rec: Recording): Promise<string> {
  const dir = recordingDir(root, rec.name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, MANIFEST), `${JSON.stringify(rec, null, 2)}\n`);
  await writeFile(join(dir, SUMMARY), `${JSON.stringify(summarizeRecording(rec))}\n`);
  return dir;
}

export async function loadRecording(root: string, name: string): Promise<Recording> {
  const file = join(recordingDir(root, name), MANIFEST);
  return JSON.parse(await readFile(file, "utf8")) as Recording;
}

async function recordingNames(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  return (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && NAME.test(d.name))
    .map((d) => d.name);
}

/** Every manifest, whole; a directory without one is a recording in progress. */
export async function listRecordings(root: string): Promise<Recording[]> {
  const out: Recording[] = [];
  for (const n of await recordingNames(root)) {
    try {
      out.push(await loadRecording(root, n));
    } catch {}
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * The rows a list shows, from each recording's small `summary.json` rather
 * than its manifest (which holds every action). A recording saved before
 * summaries existed is read whole once and given one.
 */
export async function listRecordingSummaries(root: string): Promise<RecordingSummary[]> {
  const out: RecordingSummary[] = [];
  for (const n of await recordingNames(root)) {
    const dir = recordingDir(root, n);
    try {
      out.push(JSON.parse(await readFile(join(dir, SUMMARY), "utf8")) as RecordingSummary);
      continue;
    } catch {}
    try {
      const summary = summarizeRecording(await loadRecording(root, n));
      await writeFile(join(dir, SUMMARY), `${JSON.stringify(summary)}\n`);
      out.push(summary);
    } catch {}
  }
  // Newest first, ties by name: the order `/api/recordings` pages through by `startedAt~name`.
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.name.localeCompare(a.name));
}
