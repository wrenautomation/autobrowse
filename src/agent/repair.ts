/**
 * A flow's failure record as an agent goal: pick up on the page where
 * the flow stopped and finish what it was doing. Shared by the CLI
 * (`autobrowse repair`) and the UI's "repair with agent" button.
 */
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { FailureRecord } from "../browser/session.js";
import type { StartRequest } from "./sessions.js";

export function repairGoal(record: FailureRecord, goal?: string): string {
  const aim =
    goal ??
    (record.goal
      ? `finish what the flow "${record.flow}" was doing: its next act was "${record.goal}"`
      : `finish what the flow "${record.flow}" was doing`);
  return `${aim}. The flow stopped here with: ${record.error}`;
}

/** The recording name a repair saves under. */
export function repairName(record: FailureRecord): string {
  const s = `${record.flow}-repair`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
  return /^[a-z]/.test(s) ? s : `r-${s}`;
}

/** Read a failure record; with `under`, only from inside that directory (a request's path). */
export function readFailure(file: string, under?: string): FailureRecord {
  const full = resolve(file);
  if (under) {
    const base = resolve(under);
    if (full !== base && !full.startsWith(base + sep))
      throw new Error("failure record must live under the artifacts dir");
  }
  return JSON.parse(readFileSync(full, "utf8")) as FailureRecord;
}

export function repairRequest(record: FailureRecord, goal?: string): StartRequest {
  return { site: record.site, goal: repairGoal(record, goal), url: record.url };
}
