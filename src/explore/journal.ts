/** An explore session's files: the journal of acts that worked (a recording in the making) and the owner-only token file the CLI leaves for the session's life. */
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "../recorder/types.js";

/** An action minus what the journal fills in, per union member. */
export type Journaled = Action extends infer A
  ? A extends Action
    ? Omit<A, "t" | "url">
    : never
  : never;

/** Where a session's journal lives between lives: `id` is the port (CLI) or the agent session. */
export const journalFileFor = (recordingsDir: string, site: string, id: string): string =>
  join(recordingsDir, `.explore-${site}`, `journal-${id}.jsonl`);

/** The acts a dead session left, oldest first; lines that do not parse are skipped. */
export function readJournal(file: string): Action[] {
  if (!existsSync(file)) return [];
  const out: Action[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Action);
    } catch {
      // a line cut by the crash
    }
  }
  return out;
}

/** The token file the CLI uses for a port: `$TMPDIR/autobrowse/explore-<port>.token`. */
export const tokenFileFor = (port: number): string =>
  join(tmpdir(), "autobrowse", `explore-${port}.token`);
