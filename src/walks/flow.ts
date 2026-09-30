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
import type { OpValue } from "../compiler/outline.js";
import type { SecretSink } from "../deps/sink.js";
import { samePage, shows } from "./build.js";
import { MAX_DEPTH, type ScreenSpec, type WalkOp, type WalkSpec } from "./spec.js";

export interface WalkDeps {
  /** Placed secrets by name (`google.password`, `code`); missing: a person types it. */
  secrets?: SecretValues;
  /** Where `keep` puts what it reads; missing: a person keeps it. */
  sink?: SecretSink;
  /** Another walk, for a `walk` op. */
  load?(site: string, name: string): WalkSpec | null;
}

/** Plan values by field key; a field left out gets the example the run typed. */
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

  const textFor = async (v: OpValue, goal: string): Promise<string> => {
    if (v.from === "literal") return v.text;
    if (v.from === "plan") {
      const given = input[v.field] ?? fields.get(v.field)?.example;
      return given ?? fp.human(`${goal}: no ${v.field} given (--plan ${v.field}=…)`);
    }
    const s = await deps.secrets?.(v.key);
    return s ?? fp.human(`${goal}: secret ${v.key} is not available here`);
  };

  const run = async (op: WalkOp): Promise<void> => {
    switch (op.kind) {
      case "click":
        return fp.act({ kind: "click" }, op.hints as Hints, {
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
        return fp.act({ kind: "select", value: op.value }, op.hints as Hints, { goal: op.goal });
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
        return fp.open(op.url);
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
