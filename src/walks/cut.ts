/**
 * Cut one run into parts (designs/2026-10-23-cut-runs.md): a cut file names
 * act ranges, and each range becomes its own walk. The file is JSON with this
 * zod schema (`cutJsonSchema` for an editor); `draftCut` writes a first one
 * from the run's `cut` marks, else from guesses.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { reshape, urlShape } from "../browser/screens.js";
import { hintsSchema } from "../compiler/outline.js";
import { camel, IRREVERSIBLE_CLICK, kebab, stripHints } from "../compiler/structure.js";
import type { Action } from "../recorder/types.js";
import { baseSite, listRuns, type RunRow, type RunSummary, readRun, runFile } from "../runs/log.js";
import { type Around, type BuiltWalk, inUrl, walkFromRuns } from "./build.js";
import {
  fieldRefs,
  WALK_VERSION,
  type WalkField,
  type WalkOp,
  type WalkSpec,
  walkOpSchema,
  walkSpecSchema,
} from "./spec.js";

const RUN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const NAME = /^[a-z][a-z0-9-]*$/;
const KEY = /^[a-z][a-zA-Z0-9]*$/;
/** `37-44`, `40`, or a cut mark's name (from it to the next mark); `<run>:` before it picks a run other than the first. */
const ACTS = /^(?:(\d{8}-\d{6}-[0-9a-f]{4}):)?(?:(\d+)(?:-(\d+))?|([a-z][a-z0-9-]*))$/;
/** An act's number: its place among the run's act rows, from 1. */
const act = z.number().int().positive();
const acts = z.string().regex(ACTS);

/** Before or after one act: exactly one of them. */
const oneSide = (r: {
  at?: number | undefined;
  before?: number | undefined;
  after?: number | undefined;
}) => [r.at ?? r.before, r.after].filter((x) => x != null).length === 1;

const partSchema = z
  .object({
    name: z.string().regex(NAME),
    acts,
    goal: z.string().optional(),
    /**
     * A field per key, from: `url:<q>` the value of query key q in a URL it
     * opens (that value becomes `{key}` in every URL); `upload:<act>` the
     * file; `typed:<act>` the text; `click:<act>` the clicked name.
     */
    params: z
      .record(
        z.string().regex(KEY),
        z.string().regex(/^(?:url:[A-Za-z_][\w-]*|(?:upload|typed|click):\d+)$/),
      )
      .optional(),
    /** These acts once per row of field `over` (a nested walk); a row's own `{i}` and fields fill it. */
    repeat: z
      .object({ acts, over: z.string().regex(KEY), as: z.string().regex(KEY).optional() })
      .strict()
      .optional(),
    /** The act that creates, sends or pays: `submit: false` stops before it. */
    gate: act.optional(),
    /** Text read `at` (before) or `after` an act, kept under `as`. */
    reads: z
      .array(
        z
          .object({
            at: act.optional(),
            after: act.optional(),
            as: z.string().regex(KEY),
            hints: hintsSchema,
            /** Keep this regex's first group of the text (`Submission ID:? (\\d+)`). */
            match: z.string().min(1).optional(),
          })
          .strict()
          .refine(oneSide, "at or after, one of them"),
      )
      .optional(),
    /** Acts the walk leaves out: a repeat's other rows, a click on nothing (a dialog's body). */
    skip: z.array(act).optional(),
    /** Ops the run did not journal (an old run's eval), `before` or `after` an act. */
    insert: z
      .array(
        z
          .object({ before: act.optional(), after: act.optional(), op: walkOpSchema })
          .strict()
          .refine(oneSide, "before or after, one of them"),
      )
      .optional(),
  })
  .strict();
export type CutPart = z.infer<typeof partSchema>;

export const cutSchema = z
  .object({
    site: z.string(),
    runs: z.array(z.string().regex(RUN)).min(1),
    /** The sign-in: built as the walk `login`, run by `walkLogin` with this credential. */
    login: z.object({ acts, credential: z.string().optional() }).strict().optional(),
    parts: z.array(partSchema),
    /** A walk of walks, in order; each step opens its own start first. */
    workflows: z
      .array(
        z
          .object({
            name: z.string().regex(NAME),
            goal: z.string().optional(),
            steps: z.array(z.string().regex(NAME)).min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const names = new Set<string>(c.login ? ["login"] : []);
    c.parts.forEach((p, i) => {
      if (names.has(p.name))
        ctx.addIssue({ code: "custom", path: ["parts", i, "name"], message: "not unique" });
      names.add(p.name);
    });
    c.workflows?.forEach((w, i) => {
      w.steps.forEach((s, j) => {
        if (!names.has(s))
          ctx.addIssue({
            code: "custom",
            path: ["workflows", i, "steps", j],
            message: `names no part: ${s}`,
          });
      });
    });
  });
export type CutFile = z.infer<typeof cutSchema>;

/** For an editor: completes and checks a cut file. */
export const cutJsonSchema = (): unknown => z.toJSONSchema(cutSchema, { io: "input" });

export const cutFile = (walksDir: string, site: string, run: string): string => {
  if (!RUN.test(run)) throw new Error(`"${run}" is not a run id`);
  return join(walksDir, baseSite(site), "cuts", `${run}.json`);
};

export function loadCut(file: string): CutFile | null {
  return existsSync(file) ? cutSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : null;
}

export function saveCut(file: string, cut: CutFile): void {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(cutSchema.parse(cut), null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(`${file}.tmp`, file);
}

type ActRow = Extract<RunRow, { kind: "act" }>;
const actsOf = (rows: readonly RunRow[]): ActRow[] =>
  rows.filter((r): r is ActRow => r.kind === "act");

const nameOf = (a: Action): string | null =>
  "target" in a && a.target ? (a.target.name ?? a.target.text ?? null) : null;

/** A range → [from, to] act numbers on its run. */
function rangeOf(ref: string, cut: CutFile, runs: ReadonlyMap<string, RunRow[]>) {
  const m = ACTS.exec(ref);
  if (!m) throw new Error(`"${ref}" is not an act range`);
  const run = m[1] ?? (cut.runs[0] as string);
  const rows = runs.get(run);
  if (!rows) throw new Error(`${ref}: run ${run} is not in runs`);
  const all = actsOf(rows);
  if (m[2]) {
    const from = Number(m[2]);
    const to = Number(m[3] ?? m[2]);
    if (from > to || to > all.length) throw new Error(`${ref}: the run has ${all.length} acts`);
    return { run, from, to };
  }
  const at = all.findIndex((r) => r.act.kind === "cut" && r.act.name === m[4]);
  if (at < 0) throw new Error(`${ref}: no cut mark of that name in run ${run}`);
  const next = all.findIndex((r, i) => i > at && r.act.kind === "cut");
  return { run, from: at + 2, to: next < 0 ? all.length : next };
}

/** The value of query key `q` in the first URL in these acts that has it. */
function queryValue(rows: readonly ActRow[], q: string): string | null {
  for (const r of rows) {
    try {
      const v = new URL(r.act.url).searchParams.get(q);
      if (v) return v;
    } catch {
      // not a URL
    }
  }
  return null;
}

/** One part (or a repeat inside it) → a walk, from the rows it cuts out of its run. */
function buildPart(
  site: string,
  name: string,
  p: Omit<CutPart, "name" | "acts" | "repeat"> & {
    repeat?: CutPart["repeat"] | undefined;
    /** A sign-in: no act in it sends anything, and it starts on the page it lands on, not a one-time sign-in URL. */
    signIn?: boolean;
  },
  range: { run: string; from: number; to: number },
  rows: readonly RunRow[],
  summary: RunSummary,
  cut: CutFile,
  runs: ReadonlyMap<string, RunRow[]>,
  now: Date,
): BuiltWalk[] {
  const all = actsOf(rows);
  const mine = all.slice(range.from - 1, range.to);
  const num = new Map<Action, number>(all.map((r, i) => [r.act, i + 1]));
  const around = new Map<number, Around>();
  const at = (n: number): Around => {
    const a = around.get(n) ?? {};
    around.set(n, a);
    return a;
  };
  const add = (n: number, side: "before" | "after", op: WalkOp) => {
    const a = at(n);
    a[side] = [...(a[side] ?? []), op];
  };
  const inner = p.repeat ? rangeOf(p.repeat.acts, cut, runs) : null;
  const fields: WalkField[] = [];
  const urlParams: { key: string; value: string }[] = [];
  for (const [key, from] of Object.entries(p.params ?? {})) {
    const [how, what] = from.split(":") as [string, string];
    if (how === "url") {
      const value = queryValue(mine, what);
      if (!value)
        throw new Error(`${name}: no URL in acts ${range.from}-${range.to} has ?${what}=`);
      urlParams.push({ key, value });
      fields.push({ key, label: what, example: value });
      continue;
    }
    const n = Number(what);
    const a = all[n - 1]?.act;
    if (!a || n < range.from || n > range.to)
      throw new Error(`${name}: act ${n} is not in ${range.from}-${range.to}`);
    if (how === "click") {
      if (a.kind !== "click") throw new Error(`${name}: act ${n} is a ${a.kind}, not a click`);
      const hints = stripHints(a.target);
      const named = a.target.name ? "name" : "text";
      at(n).ops = [
        {
          kind: "click",
          goal: `click {${key}}`,
          hints: { ...hints, [named]: `{${key}}`, nth: null },
          irreversible: p.gate === n,
        },
      ];
      if (!inner || n < inner.from || n > inner.to)
        fields.push({ key, label: key, example: nameOf(a) });
    } else {
      const want = how === "upload" ? "upload" : "input";
      if (a.kind !== want) throw new Error(`${name}: act ${n} is a ${a.kind}, not an ${want}`);
      at(n).key = key;
    }
  }
  if (p.signIn) for (let n = range.from; n <= range.to; n++) at(n).irreversible = false;
  if (p.gate) {
    if (p.gate < range.from || p.gate > range.to)
      throw new Error(`${name}: gate ${p.gate} is not in ${range.from}-${range.to}`);
    at(p.gate).irreversible = true;
  }
  for (const r of p.reads ?? []) {
    const op: WalkOp = {
      kind: "read",
      goal: `read ${r.as}`,
      hints: r.hints,
      as: r.as,
      ...(r.match ? { match: r.match } : {}),
    };
    if (r.at) add(r.at, "before", op);
    else if (r.after) add(r.after, "after", op);
  }
  for (const n of p.skip ?? []) {
    if (n < range.from || n > range.to)
      throw new Error(`${name}: skip ${n} is not in ${range.from}-${range.to}`);
    at(n).ops = [];
  }
  for (const x of p.insert ?? []) {
    const n = (x.before ?? x.after) as number;
    if (n < range.from || n > range.to) continue;
    add(n, x.before ? "before" : "after", x.op);
    // A `{field}` the op names (a pick's `{choices}`): a field of this walk, unless a nested one runs it.
    if (!inner || n < inner.from || n > inner.to)
      for (const key of fieldRefs(x.op))
        if (!fields.some((f) => f.key === key)) fields.push({ key, label: key, example: null });
  }

  const out: BuiltWalk[] = [];
  if (p.repeat && inner) {
    if (inner.run !== range.run || inner.from < range.from || inner.to > range.to)
      throw new Error(`${name}: repeat ${p.repeat.acts} is not inside ${range.from}-${range.to}`);
    const each = `${name}-each`;
    out.push(
      ...buildPart(
        site,
        each,
        {
          ...p,
          repeat: undefined,
          gate: undefined,
          skip: p.skip?.filter((n) => n >= inner.from && n <= inner.to),
          goal: `one row of ${p.repeat.over}`,
        },
        inner,
        rows,
        summary,
        cut,
        runs,
        now,
      ),
    );
    // The nested walk does these acts and what a cut adds around them.
    for (let n = inner.from; n <= inner.to; n++) around.set(n, { ops: [] });
    at(inner.from).ops = [
      {
        kind: "each",
        goal: `each of ${p.repeat.over}`,
        over: p.repeat.over,
        walk: each,
        as: p.repeat.as ?? "rows",
      },
    ];
    fields.push({ key: p.repeat.over, label: p.repeat.over, example: null });
  }

  // The part's own rows: a start, its acts, and an end on the page the last act landed on.
  // A look is taken before an act, so that page's landmarks come from the next act's look or the
  // run's end, and only when that look is on the same page; else the end knows the page by its URL.
  const start = rows.find((r) => r.kind === "start");
  const end = [...rows].reverse().find((r) => r.kind === "end");
  const last = mine.at(-1) as ActRow;
  // A sign-in redirects after its last act (Duo, then the SAML hop): it lands where the run went next.
  const landedOn = urlShape((p.signIn && all[range.to]?.act.url) || last.act.url);
  const after = [
    all[range.to]?.look,
    range.to === all.length && end?.kind === "end" ? end.look : null,
  ].map((l) => l && reshape(l));
  const part: RunRow[] = [
    ...(start ? [{ ...start, goal: p.goal ?? null }] : []),
    ...mine,
    {
      kind: "end",
      at: last.at,
      outcome: "achieved",
      summary: null,
      look: after.find((l) => l?.url === landedOn) ?? { url: landedOn, landmarks: [] },
    },
  ];
  const built = walkFromRuns(
    [{ summary: { ...summary, outcome: "achieved", endedAt: last.at }, rows: part }],
    {
      site,
      name,
      goal: p.goal ?? `${name} on ${baseSite(site)}`,
      now,
      around: (a) => around.get(num.get(a) ?? 0),
      fields,
    },
  );
  const landed = all[range.to]?.act.url;
  if (p.signIn && landed) built.spec = walkSpecSchema.parse({ ...built.spec, start: landed });
  if (!urlParams.length) return [...out, built];
  // A query value the run never typed: `{key}` wherever it stands in a URL the walk opens.
  const tpl = (url: string) => urlParams.reduce((u, f) => inUrl(u, f.value, f.key), url);
  const spec = walkSpecSchema.parse({
    ...built.spec,
    start: built.spec.start && tpl(built.spec.start),
    screens: built.spec.screens.map((s) => ({
      ...s,
      ops: s.ops.map((op) => (op.kind === "open" ? { ...op, url: tpl(op.url) } : op)),
    })),
  } satisfies WalkSpec);
  return [...out, { ...built, spec }];
}

/** A walk of walks: each step opens its own start, then runs. */
function workflowOf(
  site: string,
  w: NonNullable<CutFile["workflows"]>[number],
  built: ReadonlyMap<string, WalkSpec>,
  now: Date,
): WalkSpec {
  const ops: WalkOp[] = [];
  const fields = new Map<string, WalkField>();
  for (const step of w.steps) {
    const s = built.get(step) as WalkSpec;
    if (s.start) {
      ops.push({ kind: "open", goal: `open ${step}`, url: s.start });
      for (const f of s.fields)
        if (s.start.includes(`%7B${f.key}%7D`) && !fields.has(f.key)) fields.set(f.key, f);
    }
    ops.push({ kind: "walk", goal: step, walk: step });
  }
  return walkSpecSchema.parse({
    version: WALK_VERSION,
    site: baseSite(site),
    name: w.name,
    goal: w.goal ?? w.steps.join(", then "),
    built: now.toISOString(),
    from: [],
    start: null,
    fields: [...fields.values()],
    secrets: [],
    irreversible: w.steps.some((s) => built.get(s)?.irreversible),
    screens: [
      { name: "steps", looks: "any page", url: null, landmarks: [], ops, seen: 0 },
      {
        name: "done",
        looks: "the last step's goal",
        url: null,
        landmarks: [],
        ops: [],
        goal: true,
        after: ["steps"],
        seen: 0,
      },
    ],
  } satisfies WalkSpec);
}

export interface CutResult {
  walks: BuiltWalk[];
  workflows: WalkSpec[];
}

/** Build every part, the sign-in and the workflows of a cut file. Pure over the rows given. */
export function buildCut(
  cut: CutFile,
  runs: ReadonlyMap<string, { summary: RunSummary; rows: RunRow[] }>,
  now = new Date(),
): CutResult {
  const rowsBy = new Map([...runs].map(([k, v]) => [k, v.rows]));
  const walks: BuiltWalk[] = [];
  const one = (name: string, p: Omit<CutPart, "name"> & { signIn?: boolean }) => {
    const range = rangeOf(p.acts, cut, rowsBy);
    const r = runs.get(range.run) as { summary: RunSummary; rows: RunRow[] };
    walks.push(...buildPart(cut.site, name, p, range, r.rows, r.summary, cut, rowsBy, now));
  };
  if (cut.login) {
    one("login", { acts: cut.login.acts, goal: `sign in to ${baseSite(cut.site)}`, signIn: true });
    const login = walks.at(-1) as BuiltWalk;
    if (cut.login.credential) login.spec = asCredential(login.spec, cut.login.credential);
  }
  for (const p of cut.parts) one(p.name, p);
  const byName = new Map(walks.map((w) => [w.spec.name, w.spec]));
  return {
    walks,
    workflows: (cut.workflows ?? []).map((w) => workflowOf(cut.site, w, byName, now)),
  };
}

/**
 * A sign-in's secrets as one credential's: `<cred>.username`, `<cred>.password`,
 * and any other (a bare `passcode`) `<cred>.code`, so a walk run anywhere asks that credential's inbox.
 */
function asCredential(spec: WalkSpec, cred: string): WalkSpec {
  const keyOf = (k: string) => {
    const field = k.slice(k.lastIndexOf(".") + 1);
    return `${cred}.${field === "username" || field === "password" ? field : "code"}`;
  };
  const keys = [...new Set(spec.secrets.map((x) => keyOf(x.key)))];
  return walkSpecSchema.parse({
    ...spec,
    secrets: keys.map((key) => ({
      key,
      label: spec.secrets.find((x) => keyOf(x.key) === key)?.label ?? key,
    })),
    screens: spec.screens.map((sc) => ({
      ...sc,
      ops: sc.ops.map((op) =>
        "value" in op && typeof op.value === "object" && op.value?.from === "secret"
          ? { ...op, value: { ...op.value, key: keyOf(op.value.key) } }
          : op,
      ),
    })),
  });
}

const SIGN_IN_HOST =
  /(^|\.)(adfs|sso|login|signin|auth|idp|accounts?)\.|duosecurity\.com$|okta\.com$/;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};
/** A URL's area: its first three path parts that are not ids (`d2l/lms/dropbox`). */
const familyOf = (url: string): string => {
  try {
    return new URL(url).pathname
      .split("/")
      .filter((s) => s && !/^\d+$/.test(s) && !s.includes("."))
      .slice(0, 3)
      .join("/");
  } catch {
    return "";
  }
};

/**
 * A first cut file for a run: its `cut` marks, else guesses. A sign-in host
 * at the start is `login`; a new URL area starts a part; an id in a query is
 * a param; an upload is `file`; the first click the gate names is the gate.
 */
export function draftCut(site: string, run: string, rows: readonly RunRow[]): CutFile {
  const all = actsOf(rows);
  const marks = all.flatMap((r, i) =>
    r.act.kind === "cut" ? [{ name: r.act.name, n: i + 1 }] : [],
  );
  let login: CutFile["login"];
  const ranges: { name: string; from: number; to: number }[] = [];
  const first = marks[0]?.n ?? all.length + 1;
  let signedIn = 0;
  for (let i = 0; i < first - 1; i++) {
    if (SIGN_IN_HOST.test(hostOf(all[i]?.act.url ?? ""))) signedIn = i + 1;
    else if (signedIn) break;
  }
  if (signedIn) login = { acts: `1-${signedIn}` };
  if (marks.length) {
    marks.forEach((m, i) => {
      ranges.push({ name: m.name, from: m.n + 1, to: (marks[i + 1]?.n ?? all.length + 1) - 1 });
    });
  } else {
    let area = "";
    for (let i = signedIn; i < all.length; i++) {
      const a = all[i] as ActRow;
      const f = familyOf(a.act.url);
      if (f !== area || !ranges.length) {
        const base = kebab(f.split("/").at(-1) ?? "") || "part";
        let name = base;
        for (let k = 2; ranges.some((r) => r.name === name); k++) name = `${base}-${k}`;
        ranges.push({ name, from: i + 1, to: 0 });
        area = f;
      }
    }
    ranges.forEach((r, i) => {
      r.to = (ranges[i + 1]?.from ?? all.length + 1) - 1;
    });
  }
  const parts: CutPart[] = ranges
    .filter((r) => r.to >= r.from)
    .map((r) => {
      const mine = all.slice(r.from - 1, r.to);
      const params: Record<string, string> = {};
      // Only a URL it opens: an id seen on the way (a submission's) is a read, not a param.
      for (const a of mine.filter((x, i) => i === 0 || x.act.kind === "navigate"))
        try {
          for (const [q, v] of new URL(a.act.url).searchParams)
            if (/^\d{3,}$/.test(v) && KEY.test(camel(q)) && !(camel(q) in params))
              params[camel(q)] = `url:${q}`;
        } catch {
          // not a URL
        }
      mine.forEach((a, i) => {
        if (a.act.kind === "upload" && !("file" in params)) params.file = `upload:${r.from + i}`;
      });
      const gate = mine.findIndex(
        (a) => a.act.kind === "click" && IRREVERSIBLE_CLICK.test(nameOf(a.act) ?? ""),
      );
      return {
        name: r.name,
        acts: marks.length ? r.name : `${r.from}-${r.to}`,
        ...(Object.keys(params).length ? { params } : {}),
        ...(gate >= 0 ? { gate: r.from + gate } : {}),
      };
    });
  return cutSchema.parse({ site: baseSite(site), runs: [run], ...(login ? { login } : {}), parts });
}

/** Read a cut's runs from the runs folder. */
export function cutRuns(
  runsDir: string,
  cut: CutFile,
): Map<string, { summary: RunSummary; rows: RunRow[] }> {
  const index = listRuns(runsDir);
  const out = new Map<string, { summary: RunSummary; rows: RunRow[] }>();
  for (const run of cut.runs) {
    const rows = readRun(runFile(runsDir, cut.site, run));
    if (!rows.length) throw new Error(`run ${run} has no rows on ${cut.site}`);
    const summary = index.find((r) => r.run === run) ?? summaryOf(cut.site, run, rows);
    out.set(run, { summary, rows });
  }
  return out;
}

/** A run with no index line (cut by a crash): what the builder reads of a summary. */
const summaryOf = (site: string, run: string, rows: readonly RunRow[]): RunSummary => {
  const start = rows.find((r) => r.kind === "start");
  const at = rows.at(-1)?.at ?? new Date(0).toISOString();
  return {
    run,
    site,
    driver: start?.kind === "start" ? start.driver : "console",
    goal: start?.kind === "start" ? start.goal : null,
    outcome: "achieved",
    summary: null,
    startedAt: start?.at ?? at,
    endedAt: at,
    cmds: 0,
    acts: actsOf(rows).length,
    tokens: 0,
  } as RunSummary;
};
