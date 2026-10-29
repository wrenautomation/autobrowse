/**
 * Where usage stats land when a caller names no place: model calls (`llm/`),
 * flow runs (`flows/`) and in-process engine runs (`engine/`) under
 * `~/.config/autobrowse`, the folder the CLI reads (`autobrowse tokens`,
 * `autobrowse success`). On by default, so a
 * library caller gets token and failure history with no setup.
 * `AUTOBROWSE_STATS=off` turns it off; `AUTOBROWSE_STATS_DIR` moves it.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function statsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.AUTOBROWSE_STATS === "off") return null;
  return env.AUTOBROWSE_STATS_DIR || join(homedir(), ".config", "autobrowse");
}

/** A folder under the stats dir; null when stats are off. */
export const statsDirOf = (part: "llm" | "flows" | "engine"): string | null => {
  const d = statsDir();
  return d ? join(d, part) : null;
};

/**
 * Where stopped calls keep their resume records (`browser/resume`): beside the stats, in the
 * owner's state dir. On by default; `AUTOBROWSE_RESUME=off` turns it off (tests),
 * `RunnerOptions.resume: false` for one runner.
 */
export function resumeDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.AUTOBROWSE_RESUME === "off") return null;
  return join(env.AUTOBROWSE_STATS_DIR || join(homedir(), ".config", "autobrowse"), "resume");
}
