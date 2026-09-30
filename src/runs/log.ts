/**
 * Runs: every explore session's history, kept for good. One chained JSONL
 * file per run (`runs/<site>/<run>.jsonl`): who drove it, the goal, every
 * command with what its answer cost the caller, every act with the page it
 * was done on, and how it ended. The journal is resume state and goes on
 * `close`; the run stays. Walks are built from these (`walks/build`) and
 * the token report reads them (`runs/tokens`).
 *
 * Rows are written synchronously, like the journal, so a crash loses at
 * most the row in flight. The chain is credvault's (`rowHash`), so
 * `verifyChain` checks a run file like any other ledger. Acts are stored as
 * the journal has them: a placed secret is its name, never its value.
 */
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { rowHash } from "credvault";
import type { PageLook } from "../browser/screens.js";
import type { Action } from "../recorder/types.js";

/** How a run ended: the caller said (`done`), a `save` implied it, or the session just stopped. */
export type RunOutcome = "achieved" | "failed" | "saved" | "closed" | "idle";

export type RunRow =
  | {
      kind: "start";
      at: string;
      run: string;
      site: string;
      /** `console` (a CLI or Claude Code over the socket), `agent:<model>`, `person`. */
      driver: string;
      goal: string | null;
      machine: string;
      /** A later life of the same run, after a crash or an idle close. */
      resumed: boolean;
      /** The page's size in CSS px: what a screenshot of it would cost. */
      viewport: { width: number; height: number } | null;
    }
  | { kind: "goal"; at: string; goal: string }
  | {
      kind: "cmd";
      at: string;
      n: number;
      cmd: string;
      ok: boolean;
      error: string | null;
      ms: number;
      /** The answer as the caller got it, in chars, and about that many tokens (chars / 4). */
      chars: number;
      tokens: number;
      /**
       * What a caller that reads the whole page instead would have paid, in
       * chars: the full accessibility tree after an act or a look. Null
       * when not measured (a session command, a desktop act).
       */
      full: number | null;
      /** The page's host, never its path. */
      host: string;
    }
  | {
      kind: "act";
      at: string;
      act: Action;
      /** The page it was done on, looked at just before; null when not looked at (a person's act, an `open`). */
      look: PageLook | null;
      /** A person did it, not a command: a load it caused is not an `open` to replay. */
      hand?: true;
    }
  | {
      kind: "end";
      at: string;
      outcome: RunOutcome;
      summary: string | null;
      look: PageLook | null;
    };

type Row<K extends RunRow["kind"]> = Extract<RunRow, { kind: K }>;
/** Callers never pass `at` or `kind`: the log stamps them. */
type Body<K extends RunRow["kind"]> = Omit<Row<K>, "kind" | "at">;

/** One index line per ended life of a run: what a list reads without opening every file. */
export interface RunSummary {
  run: string;
  site: string;
  driver: string;
  goal: string | null;
  outcome: RunOutcome;
  summary: string | null;
  startedAt: string;
  endedAt: string;
  cmds: number;
  acts: number;
  /** Answer tokens the caller paid this life, and what full-page answers would have cost. */
  tokens: number;
  full: number;
}

export interface RunLog {
  readonly id: string;
  readonly file: string;
  start(b: Body<"start">): void;
  goal(goal: string): void;
  cmd(b: Omit<Body<"cmd">, "n" | "tokens">): void;
  act(act: Action, look: PageLook | null, hand?: boolean): void;
  /** Once; later calls, and any row after it, are ignored (a `done`, then the close that follows it). */
  end(b: Body<"end">): void;
  ended(): boolean;
}

/** `20260930-231500-a3f9`: the day and time it started, then four hex so two in a second differ. */
export function newRunId(now = new Date()): string {
  const s = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${s}-${randomBytes(2).toString("hex")}`;
}

/** Answer tokens as estimated everywhere here: four chars a token, the usual English rule. */
export const tokensOf = (chars: number): number => Math.ceil(chars / 4);

/** Base site: `google@ops` and `google` share walks and history. */
export const baseSite = (site: string): string => site.split("@")[0] ?? site;

const SITE_DIR = /^[a-z0-9][a-z0-9._-]*$/i;
const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

export const runFile = (dir: string, site: string, id: string): string => {
  const s = baseSite(site);
  if (!SITE_DIR.test(s)) throw new Error(`site "${site}" cannot name a runs folder`);
  if (!RUN_ID.test(id)) throw new Error(`"${id}" is not a run id`);
  return join(dir, s, `${id}.jsonl`);
};

export const INDEX = "index.jsonl";

/** The last line's hash: where the chain goes on. A file cut mid-line by a crash ends at its last whole row. */
function tipOf(text: string): string {
  const lines = text.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const h = (JSON.parse(lines[i] as string) as { hash?: unknown }).hash;
      if (typeof h === "string") return h;
    } catch {
      // a torn last line
    }
  }
  return "";
}

/**
 * A run's log. `id` continues that run (a resumed session); without one a
 * new run starts. `now` is for tests.
 */
export function runLog(
  dir: string,
  site: string,
  o: { id?: string; now?: () => Date } = {},
): RunLog {
  const now = o.now ?? (() => new Date());
  const id = o.id ?? newRunId(now());
  const file = runFile(dir, site, id);
  mkdirSync(join(dir, baseSite(site)), { recursive: true, mode: 0o700 });
  const prior = existsSync(file) ? readFileSync(file, "utf8") : "";
  let tip = tipOf(prior);
  // A crash cut the last line: the next row starts on a line of its own.
  let torn = prior !== "" && !prior.endsWith("\n");
  let n = 0;
  let acts = 0;
  let tokens = 0;
  let full = 0;
  let head: Row<"start"> | null = null;
  // A later life keeps the goal an earlier one named.
  let goal: string | null = null;
  if (o.id)
    for (const r of rowsOf(prior))
      if ((r.kind === "start" || r.kind === "goal") && r.goal) goal = r.goal;
  let done = false;
  const write = <K extends RunRow["kind"]>(kind: K, body: object): Row<K> => {
    const row = { kind, at: now().toISOString(), ...body } as Row<K>;
    const hash = rowHash(tip, row);
    appendFileSync(file, `${torn ? "\n" : ""}${JSON.stringify({ ...row, prev: tip, hash })}\n`, {
      mode: 0o600,
    });
    torn = false;
    tip = hash;
    return row;
  };
  return {
    id,
    file,
    start(b) {
      head = write("start", b);
      goal = b.goal ?? goal;
    },
    goal(g) {
      if (done) return;
      goal = g;
      write("goal", { goal: g });
    },
    cmd(b) {
      if (done) return;
      n += 1;
      const t = tokensOf(b.chars);
      tokens += t;
      full += b.full === null ? t : tokensOf(b.full);
      write("cmd", { ...b, n, tokens: t });
    },
    act(act, look, hand = false) {
      if (done) return;
      acts += 1;
      write("act", { act, look, ...(hand ? { hand: true } : {}) });
    },
    end(b) {
      if (done) return;
      done = true;
      const end = write("end", b);
      const summary: RunSummary = {
        run: id,
        site,
        driver: head?.driver ?? "console",
        goal,
        outcome: b.outcome,
        summary: b.summary,
        startedAt: head?.at ?? end.at,
        endedAt: end.at,
        cmds: n,
        acts,
        tokens,
        full,
      };
      appendFileSync(join(dir, INDEX), `${JSON.stringify(summary)}\n`, { mode: 0o600 });
    },
    ended: () => done,
  };
}

/** Rows of one run, oldest first; a torn line is skipped. */
export function readRun(file: string): RunRow[] {
  return existsSync(file) ? rowsOf(readFileSync(file, "utf8")) : [];
}

function rowsOf(text: string): RunRow[] {
  const out: RunRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RunRow);
    } catch {
      // cut by a crash
    }
  }
  return out;
}

/** Ended runs, newest last. A run that ended twice (two lives) keeps its last line. */
export function listRuns(dir: string): RunSummary[] {
  const file = join(dir, INDEX);
  if (!existsSync(file)) return [];
  const byRun = new Map<string, RunSummary>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as RunSummary;
      byRun.delete(r.run);
      byRun.set(r.run, r);
    } catch {
      // torn
    }
  }
  return [...byRun.values()];
}

/** The kind of a file's last whole row, read from its tail: `end` when its last life ended. */
function lastKind(file: string): string | null {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const n = Math.min(size, TAIL);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    const line = buf.toString("utf8").trimEnd().split("\n").at(-1) ?? "";
    return (JSON.parse(line) as { kind?: string }).kind ?? null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
const TAIL = 64 * 1024;

/**
 * Runs whose last life never wrote an `end` (the process died): found by
 * their files, since the index only has ended lives. Only a run the index
 * has is read, and only its last row.
 */
export function openRuns(dir: string): { site: string; run: string }[] {
  if (!existsSync(dir)) return [];
  const ended = new Set(listRuns(dir).map((r) => r.run));
  const out: { site: string; run: string }[] = [];
  for (const site of readdirSync(dir, { withFileTypes: true })) {
    if (!site.isDirectory()) continue;
    for (const f of readdirSync(join(dir, site.name))) {
      const run = f.replace(/\.jsonl$/, "");
      if (!RUN_ID.test(run)) continue;
      if (!ended.has(run) || lastKind(join(dir, site.name, f)) !== "end")
        out.push({ site: site.name, run });
    }
  }
  return out;
}

export const machine = (): string => hostname().split(".")[0] ?? "host";
