/**
 * One interpreter for every walk: a `WalkSpec` becomes a screens walk
 * (`browser/screens.walk`). A screen is on when the page has its URL shape
 * and landmarks and the screens it comes after are done; its ops run with
 * the runner's own `act`, so repair, gates and pacing are the same as any
 * flow's. A page no screen knows goes down the runner's ladder (learned
 * screens, then the reader), then to a person.
 */
import type { SecretValues } from "../auth/signup.js";
import { type BrowserFlow, defineFlow, type FlowPage } from "../browser/flow.js";
import type { Hints } from "../browser/locate.js";
import { lookAt, type PageLook, type Screen, walk } from "../browser/screens.js";
import type { SecretSink } from "../deps/sink.js";
import { samePage, shows } from "./build.js";
import {
  FIELD_REF,
  MAX_DEPTH,
  type ProfileFieldName,
  RELATIVE_DAY,
  type ScreenSpec,
  type WalkField,
  type WalkOp,
  type WalkSpec,
  type WalkValue,
} from "./spec.js";

export interface WalkDeps {
  /** Placed secrets by name (`google.password`, `code`); missing: a person types it. */
  secrets?: SecretValues;
  /** Where `keep` puts what it reads; missing: a person keeps it. */
  sink?: SecretSink;
  /** Another walk, for a `walk` op. */
  load?(site: string, name: string): WalkSpec | null;
  /** The runner's profile field (`--profile`); missing or null: a person types it. */
  profile?(field: ProfileFieldName): Promise<string | null>;
  /** A field with no value and no default (a terminal asks); missing or null: a person types it. */
  ask?(field: WalkField, goal: string): Promise<string | null>;
  now?(): Date;
}

/** `today+3d` → that day, as `YYYY-MM-DD` or `MM/DD/YYYY`; any other default is the text. */
export function resolveDefault(d: string, now: Date): string {
  const m = RELATIVE_DAY.exec(d);
  if (!m) return d;
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + Number(m[1]));
  const yyyy = String(day.getFullYear());
  const mm = String(day.getMonth() + 1).padStart(2, "0");
  const dd = String(day.getDate()).padStart(2, "0");
  return m[2] === "MM/DD/YYYY" ? `${mm}/${dd}/${yyyy}` : `${yyyy}-${mm}-${dd}`;
}

/** Plan values by field key; a field left out gets its default (v1: the example the run typed). */
export type WalkInput = Record<string, string | undefined>;

export interface WalkOutput {
  /** The goal screen reached. */
  goal: string;
  /** What `read` ops took off the page, by `as`. */
  read: Record<string, string>;
  /** Env names `keep` put in the sink; never the values. */
  kept: string[];
  /** Screens acted on, in order, nested walks included. */
  screens: string[];
}

/** A look is fresh this long: every screen's check in one pass shares it. */
const LOOK_MS = 250;
/** How long after its ops a screen's page gets to change before the walk looks anyway. */
const MOVE_MS = 5_000;

export const walkFlowName = (spec: Pick<WalkSpec, "name">): string => `walk-${spec.name}`;

/** Goal first, then the screens with the most to check: the most specific match wins. */
const ordered = (screens: readonly ScreenSpec[]): ScreenSpec[] =>
  [...screens].sort(
    (a, b) => Number(!!b.goal) - Number(!!a.goal) || b.landmarks.length - a.landmarks.length,
  );

async function walkSpec(
  fp: FlowPage,
  spec: WalkSpec,
  input: WalkInput,
  deps: WalkDeps,
  out: WalkOutput,
  depth: number,
): Promise<string> {
  if (depth === 0 && spec.start) await fp.open(spec.start);
  const fields = new Map(spec.fields.map((f) => [f.key, f]));
  const handled = new Set<string>();
  let seen: { at: number; url: string; look: PageLook } | null = null;
  const look = async (): Promise<PageLook> => {
    const url = fp.page.url();
    if (seen && seen.url === url && Date.now() - seen.at < LOOK_MS) return seen.look;
    const l = await lookAt(fp.page);
    seen = { at: Date.now(), url, look: l };
    return l;
  };

  const now = deps.now?.() ?? new Date();
  /** Asked once per run: a field filled twice (a fill, then a click on it) is one answer. */
  const asked = new Map<string, string>();
  const fieldValue = async (key: string, goal: string): Promise<string> => {
    const f = fields.get(key);
    const given =
      input[key] ??
      asked.get(key) ??
      (f?.default !== undefined ? resolveDefault(f.default, now) : undefined) ??
      // A v1 walk ran on the example; a v2 one asks.
      (spec.version === 1 ? (f?.example ?? undefined) : undefined) ??
      (f && deps.ask ? ((await deps.ask(f, goal)) ?? undefined) : undefined);
    if (given === undefined) return fp.human(`${goal}: no ${key} given (--plan ${key}=…)`);
    asked.set(key, given);
    return given;
  };
  const textFor = async (v: WalkValue, goal: string): Promise<string> => {
    if (v.from === "literal") return v.text;
    if (v.from === "plan") return fieldValue(v.field, goal);
    if (v.from === "profile") {
      const p = await deps.profile?.(v.field);
      return p ?? fp.human(`${goal}: no profile ${v.field} here (--profile <id>)`);
    }
    const s = await deps.secrets?.(v.key);
    return s ?? fp.human(`${goal}: secret ${v.key} is not available here`);
  };
  /** `{key}` → that field's value; `url` encodes it as a path or query part. */
  const fill = async (t: string, goal: string, url = false): Promise<string> => {
    const raw = url ? t.replace(/%7B/gi, "{").replace(/%7D/gi, "}") : t;
    if (!raw.match(FIELD_REF)) return t;
    let out = raw;
    for (const m of [...raw.matchAll(FIELD_REF)]) {
      const v = await fieldValue(m[1] as string, goal);
      out = out.split(m[0]).join(url ? encodeURIComponent(v) : v);
    }
    return out;
  };
  const hintsFor = async (h: WalkOp & { kind: "click" }): Promise<Hints> => {
    const out = { ...h.hints } as Hints & { text?: string | null; name?: string | null };
    if (out.text) out.text = await fill(out.text, h.goal);
    if (out.name) out.name = await fill(out.name, h.goal);
    return out;
  };

  const run = async (op: WalkOp): Promise<void> => {
    switch (op.kind) {
      case "click":
        return fp.act({ kind: "click" }, await hintsFor(op), {
          goal: op.goal,
          irreversible: op.irreversible,
        });
      case "fill":
        return fp.act(
          { kind: "fill", value: await textFor(op.value, op.goal) },
          op.hints as Hints,
          {
            goal: op.goal,
          },
        );
      case "select":
        return fp.act({ kind: "select", value: await fill(op.value, op.goal) }, op.hints as Hints, {
          goal: op.goal,
        });
      case "press":
        return fp.act({ kind: "press", key: op.key }, op.hints as Hints, { goal: op.goal });
      case "upload":
        return fp.act(
          { kind: "upload", files: [await textFor(op.file, op.goal)] },
          op.hints as Hints,
          {
            goal: op.goal,
          },
        );
      case "read":
        out.read[op.as] = await fp.read(op.hints as Hints);
        return;
      case "keep": {
        if (!deps.sink) fp.human(`${op.goal}: nowhere to keep ${op.env} here`);
        await deps.sink.put(op.env, await fp.read(op.hints as Hints));
        out.kept.push(op.env);
        return;
      }
      case "human":
        fp.human(op.reason);
        return;
      case "open":
        return fp.open(await fill(op.url, op.goal, true));
      case "captcha": {
        const c = await fp.captcha();
        if (!c.solved) fp.human(`${op.goal}: ${c.reason ?? "not solved"}`);
        return;
      }
      case "walk": {
        const [site, name] = op.walk.includes("/")
          ? (op.walk.split("/") as [string, string])
          : [spec.site, op.walk];
        if (depth + 1 > MAX_DEPTH) fp.human(`${op.goal}: walks nest deeper than ${MAX_DEPTH}`);
        const sub = deps.load?.(site, name);
        if (!sub) fp.human(`${op.goal}: no walk ${site}/${name}`);
        await walkSpec(fp, sub, input, deps, out, depth + 1);
        return;
      }
    }
  };

  /** Until the page is not the one the ops started on, or a while passed. */
  const moved = async (from: PageLook, url: string): Promise<void> => {
    for (let t = 0; t < MOVE_MS; t += LOOK_MS) {
      seen = null;
      const now = await look();
      if (
        fp.url() !== url ||
        !samePage(from, now) ||
        now.landmarks.join("\n") !== from.landmarks.join("\n")
      )
        return;
      await fp.wait(LOOK_MS);
    }
  };

  const screens: Screen[] = ordered(spec.screens).map((s) => ({
    name: s.name,
    looks: s.looks,
    is: async () =>
      (s.after ?? []).every((a) => handled.has(a)) &&
      !(s.once !== false && handled.has(s.name)) &&
      shows(s.url, s.landmarks, await look()),
    ...(s.once === false ? { repeats: true } : {}),
    ...(s.goal
      ? { goal: true }
      : {
          act: async () => {
            const from = await look();
            const url = fp.url();
            for (const op of s.ops) await run(op);
            handled.add(s.name);
            out.screens.push(depth ? `${spec.name}/${s.name}` : s.name);
            await moved(from, url);
          },
        }),
  }));
  return walk(
    { fp },
    {
      site: spec.site,
      name: walkFlowName(spec),
      goal: spec.goal,
      screens,
      // A page that comes back (results, next page) may come back many times.
      maxSteps:
        Math.max(12, spec.screens.length + 4) *
        (spec.screens.some((s) => s.once === false) ? 10 : 1),
    },
  );
}

/** A walk as a flow the runner runs like any other: `<site>/walk-<name>` in the catalog. */
export function walkFlow(spec: WalkSpec, deps: WalkDeps = {}): BrowserFlow<WalkInput, WalkOutput> {
  return defineFlow({
    site: spec.site,
    name: walkFlowName(spec),
    async run(fp, input) {
      const out: WalkOutput = { goal: "", read: {}, kept: [], screens: [] };
      out.goal = await walkSpec(fp, spec, input ?? {}, deps, out, 0);
      return out;
    },
  });
}
