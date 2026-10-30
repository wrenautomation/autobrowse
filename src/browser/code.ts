/**
 * The agent's code over the flow primitives (designs/2026-10-29-one-workflow-system.md §3): a loop,
 * a while, a branch. One runtime for explore's `code` command and the compiled op it becomes.
 *
 * Durable by saved call results: each read/has/records saves its answer under
 * (call, args, last `open`'s URL, n). A rerun after a fix gets the saved ones back with no page
 * work; the first call with none runs live. `open` is lazy: it navigates only when a live call
 * needs the page.
 *
 * Acts (WA-969): an effect act (click, press, script) is saved `started`, then `done {to}`; a rerun
 * skips a done one and goes on from its URL. A view act (hover, fill, select, upload, `{view: true}`)
 * is queued: a live call that needs the page opens the URL, then plays the queue. So a skip
 * leaves the page right, and a replay of saved calls touches nothing.
 */
import { createHash } from "node:crypto";
import vm from "node:vm";
import type { FlowPage, Op } from "./flow.js";
import type { Hints } from "./locate.js";
import { checkRows, type RecordsOp, type Row, readRecords } from "./records.js";
import { NeedsHuman } from "./session.js";

/** Saved call results by key; a Map in tests and compiled runs, a file in explore. */
export interface CodeStore {
  get(key: string): { value: unknown } | undefined;
  set(key: string, value: unknown): void;
}

/** A store in memory: a compiled run's, and tests'. */
export const memoryStore = (): CodeStore => {
  const m = new Map<string, { value: unknown }>();
  return { get: (key) => m.get(key), set: (key, value) => m.set(key, { value }) };
};

/** One primitive call, as the trace keeps it: a debugger's view of an iteration. */
export interface CodeCall {
  /** Its place in this run's calls, from 0. */
  i: number;
  call: "open" | "act" | "read" | "has" | "records" | "wait";
  /** Short: a URL, hints, an op kind. */
  args: unknown;
  /** Earlier calls with the same key in this run. */
  n: number;
  url: string;
  ms: number;
  /** From the store: no page work. */
  stored: boolean;
  /** Text and booleans as they are; rows as a count. */
  result?: unknown;
  /** What the code passed to `log` before this call: the loop's own values. */
  log?: unknown;
  error?: string;
}

export interface CodeFailure {
  /** The call it failed on; null: the code itself threw (a TypeError). */
  call: CodeCall["call"] | null;
  i: number | null;
  n: number | null;
  url: string;
  /** The last values the code logged (`{page: 37}`). */
  log: unknown;
  error: string;
}

export interface CodeResult {
  rows: unknown[];
  log: unknown;
  calls: number;
  stored: number;
  failed?: CodeFailure;
}

/** The code failed on a call or by itself: the rows so far and where, for the agent to fix. */
export class CodeFailed extends Error {
  constructor(readonly result: CodeResult & { failed: CodeFailure }) {
    super(
      `code failed${result.failed.call ? ` at ${result.failed.call} #${result.failed.i}` : ""}: ${result.failed.error}`,
    );
  }
}

/** `records(spec)` in the code: the checked extractor, as a records op takes it. */
export interface RecordsSpec {
  fields: RecordsOp["fields"];
  code: string;
  key?: string;
  max?: number;
  goal?: string;
}

export interface CodeOptions {
  store?: CodeStore;
  trace?: (row: CodeCall) => void;
  /** Stop a loop that never ends: epoch ms. */
  deadline?: number;
  /** At most this many calls. */
  maxCalls?: number;
  /** Errors that are not the code's to fix (a person is needed, a payment gate): thrown as they are. */
  passThrough?: (err: unknown) => boolean;
  /** An act left `started` by a run that died: count it done, or do it again. Unset: stop. */
  started?: "ran" | "redo";
}

/** `fp.act`'s options in the code: `view` marks an act that changes only the page (a "Next" with no new URL). */
export type CodeActOptions = Parameters<FlowPage["act"]>[2] & { view?: boolean };

/** Acts that change only the page, never the site: queued, played again to rebuild it. */
const VIEW_ACTS = new Set(["hover", "fill", "select", "upload"]);

/** An effect act in the store. */
type ActMark = { state: "started" } | { state: "done"; from: string; to: string };

const MAX_CALLS = 20_000;
const TEXT_CAP = 300;

/** A plain JSON copy: what the store and the trace keep, and nothing of the page. */
const plain = (v: unknown): unknown =>
  v === undefined ? undefined : JSON.parse(JSON.stringify(v));

/** First line of an error; the code's own errors come from the vm's realm, not `instanceof Error`. */
const firstLine = (err: unknown): string => {
  const m = (err as { message?: unknown } | null)?.message;
  return (typeof m === "string" ? m : String(err)).split("\n")[0] ?? "";
};

/** Store scope for a plan: two runs with other inputs never share results. */
export const planScope = (plan: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(plan ?? null))
    .digest("hex")
    .slice(0, 12);

export async function runCode(
  fp: FlowPage,
  src: { code: string; plan?: Record<string, unknown> },
  o: CodeOptions = {},
): Promise<CodeResult> {
  const store = o.store ?? memoryStore();
  const seen = new Map<string, number>();
  const rows: unknown[] = [];
  const max = o.maxCalls ?? MAX_CALLS;
  let wanted = fp.url();
  /** The live page is the one the code sees: `wanted`, then `queue`. False after an `open` or a skip. */
  let synced = true;
  /** Waits and view acts since `wanted` loaded: played after it to rebuild the page. */
  let queue: Array<{ wait: number } | { act: [Op, Hints, CodeActOptions] }> = [];
  let pending: unknown;
  let lastLog: unknown;
  let calls = 0;
  let stored = 0;
  let current: CodeCall | null = null;

  const begin = (call: CodeCall["call"], args: unknown, key?: string): CodeCall => {
    if (calls >= max) throw new Error(`more than ${max} calls`);
    if (o.deadline && Date.now() > o.deadline) throw new Error("out of time");
    const k = key ?? "";
    const n = seen.get(k) ?? 0;
    if (key) seen.set(k, n + 1);
    const row: CodeCall = { i: calls++, call, args, n, url: wanted, ms: 0, stored: false };
    if (pending !== undefined) {
      row.log = pending;
      pending = undefined;
    }
    current = row;
    return row;
  };
  const finish = (row: CodeCall, t0: number) => {
    row.ms = Date.now() - t0;
    o.trace?.(row);
  };
  const ensure = async () => {
    if (synced) return;
    await fp.open(wanted);
    for (const q of queue) {
      if ("wait" in q) await fp.wait(q.wait);
      else await fp.act(...q.act);
    }
    synced = true;
  };
  /** The code is on a new URL: nothing queued after it yet. */
  const moveTo = (url: string) => {
    wanted = url;
    queue = [];
  };
  /** A call whose answer is saved: back from the store, else live. */
  const keyed = async <T>(
    call: "read" | "has" | "records",
    args: unknown,
    live: () => Promise<T>,
    shown: (v: T) => unknown,
  ): Promise<T> => {
    const base = JSON.stringify([call, args, wanted]);
    const row = begin(call, args, base);
    const key = `${base}#${row.n}`;
    const t0 = Date.now();
    const hit = store.get(key);
    if (hit) {
      stored++;
      row.stored = true;
      row.result = shown(hit.value as T);
      finish(row, t0);
      return plain(hit.value) as T;
    }
    try {
      await ensure();
      const v = await live();
      store.set(key, plain(v));
      row.result = shown(v);
      return v;
    } catch (err) {
      row.error = firstLine(err);
      throw err;
    } finally {
      if (!row.stored) finish(row, t0);
    }
  };
  const live = async <T>(
    call: CodeCall["call"],
    args: unknown,
    run: () => Promise<T>,
  ): Promise<T> => {
    const row = begin(call, args);
    const t0 = Date.now();
    try {
      await ensure();
      return await run();
    } catch (err) {
      row.error = firstLine(err);
      throw err;
    } finally {
      finish(row, t0);
    }
  };
  const text = (s: string) => (s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}…` : s);
  const actArgs = (op: Op, hints: Hints) => ({ op: op.kind, hints });

  /** Live on a page in sync; else queued for the next rebuild. Queued either way. */
  const viewAct = async (op: Op, hints: Hints, opts: CodeActOptions) => {
    queue.push({ act: [op, hints, opts] });
    if (synced) return live("act", actArgs(op, hints), () => fp.act(op, hints, opts));
    const row = begin("act", actArgs(op, hints));
    row.result = "queued";
    finish(row, Date.now());
  };
  /** Once per key: `started` before, `done` after; a rerun skips a done one. */
  const effectAct = async (op: Op, hints: Hints, opts: CodeActOptions) => {
    const args = actArgs(op, hints);
    const base = JSON.stringify(["act", args, wanted]);
    const row = begin("act", args, base);
    const key = `${base}#${row.n}`;
    const t0 = Date.now();
    const mark = store.get(key)?.value as ActMark | undefined;
    if (mark?.state === "done" || (mark?.state === "started" && o.started === "ran")) {
      stored++;
      row.stored = true;
      row.result = "done before";
      // Where it took the page: the code goes on from there.
      if (mark.state === "done" && mark.to !== mark.from) {
        moveTo(mark.to);
        synced = false;
      }
      finish(row, t0);
      return;
    }
    if (mark?.state === "started" && o.started !== "redo") {
      row.error = `act #${row.i} (${op.kind}) started on an earlier run and may have run: look at the page, then send again with started "ran" or "redo"`;
      finish(row, t0);
      throw new Error(row.error);
    }
    try {
      store.set(key, { state: "started" } satisfies ActMark);
      await ensure();
      const from = fp.url();
      await fp.act(op, hints, opts);
      const to = fp.url();
      store.set(key, { state: "done", from, to } satisfies ActMark);
      if (to !== from) moveTo(to);
    } catch (err) {
      // A throw is a miss, not a site change: the next run tries it again.
      store.set(key, { state: "failed" });
      row.error = firstLine(err);
      throw err;
    } finally {
      finish(row, t0);
    }
  };

  // Built by hand: no `fp.page`, so nothing reaches around the gates.
  const sandboxFp = Object.freeze({
    open: async (url: string) => {
      const row = begin("open", url);
      moveTo(String(url));
      synced = false;
      row.url = wanted;
      finish(row, Date.now());
    },
    act: (op: Op, hints: Hints, opts: CodeActOptions) => {
      const { view, ...rest } = opts ?? ({} as CodeActOptions);
      return view || VIEW_ACTS.has(op.kind) ? viewAct(op, hints, rest) : effectAct(op, hints, rest);
    },
    read: (hints: Hints) =>
      keyed(
        "read",
        hints,
        () => fp.read(hints),
        (t) => text(String(t)),
      ),
    has: (hints: Hints, withinMs?: number) =>
      keyed(
        "has",
        withinMs ? { hints, withinMs } : hints,
        () => fp.has(hints, withinMs),
        (b) => b,
      ),
    wait: async (ms: number) => {
      queue.push({ wait: ms });
      if (synced) return live("wait", ms, () => fp.wait(ms));
      const row = begin("wait", ms);
      finish(row, Date.now());
    },
    human: (reason: string) => fp.human(reason),
  });
  const records = (spec: RecordsSpec): Promise<Row[]> => {
    const first = spec.fields[0]?.key;
    if (!first) throw new Error("records: no fields");
    const op: RecordsOp = {
      kind: "records",
      goal: spec.goal ?? "rows",
      as: "rows",
      fields: spec.fields,
      key: spec.key ?? first,
      code: spec.code,
      min: 0,
      sample: [],
      ...(spec.max ? { max: spec.max } : {}),
    };
    return keyed(
      "records",
      {
        fields: spec.fields.map((f) => f.key),
        key: op.key,
        code: spec.code,
        max: spec.max ?? null,
      },
      async () => {
        const { rows } = await readRecords(fp, op);
        // A required field empty on most rows: the extractor is wrong here, not the page empty.
        const problem = checkRows(rows, op);
        if (problem) throw new Error(`records: ${problem}`);
        return rows;
      },
      (r) => ({ rows: r.length }),
    );
  };
  const log = (values: unknown) => {
    pending = plain(values);
    lastLog = pending;
  };

  const context = vm.createContext(
    { fp: sandboxFp, records, log, plan: Object.freeze(plain(src.plan ?? {})), rows },
    { codeGeneration: { strings: false, wasm: false } },
  );
  const result = (): CodeResult => ({ rows, log: lastLog, calls, stored });
  try {
    const run = vm.runInContext(`(async () => {\n${src.code}\n})()`, context, {
      timeout: 5_000,
      filename: "code.js",
    }) as Promise<unknown>;
    await run;
    // Every result came from the store: the page is where the code last opened.
    await ensure();
    return result();
  } catch (err) {
    if (err instanceof NeedsHuman || o.passThrough?.(err)) throw err;
    const at = current as CodeCall | null;
    const failedOnCall = at?.error !== undefined;
    throw new CodeFailed({
      ...result(),
      failed: {
        call: failedOnCall ? at.call : null,
        i: failedOnCall ? at.i : null,
        n: failedOnCall ? at.n : null,
        url: wanted,
        log: lastLog,
        error: firstLine(err),
      },
    });
  }
}
