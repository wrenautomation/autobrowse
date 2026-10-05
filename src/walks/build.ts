/**
 * Runs → a walk, deterministically. Each run is cut into visits: the acts
 * done on one page, a new visit where the page's look changed. Visits from
 * every run are clustered by look (same URL shape, most landmarks shared);
 * a cluster is a screen, known by the landmarks its visits all showed and
 * others on the same URL did not. The ops are the newest run's there, so a
 * site that changed is followed by the run that last worked. The goal is
 * the page the runs ended on. A second visit to the same page is its own
 * screen, after the first; a branch one run took and another did not is a
 * screen only that run saw, found by the page when it comes up.
 */
import type { Hints } from "../browser/locate.js";
import type { PageLook } from "../browser/screens.js";
import { camel, describe, IRREVERSIBLE_CLICK, kebab, stripHints } from "../compiler/structure.js";
import { paymentGate } from "../gates/payment.js";
import { type Profile, profileField } from "../money/profile.js";
import type { Action, LocatorHints } from "../recorder/types.js";
import { baseSite, listRuns, type RunRow, type RunSummary, readRun, runFile } from "../runs/log.js";
import {
  PROFILE_FIELDS,
  type ProfileFieldName,
  type ScreenSpec,
  WALK_VERSION,
  type WalkField,
  type WalkOp,
  type WalkSpec,
  type WalkValue,
  walkSpecSchema,
} from "./spec.js";

export interface RunInput {
  summary: RunSummary;
  rows: RunRow[];
}

export interface BuildOptions {
  site: string;
  name: string;
  /** The walk's goal in words; default: the newest run's. */
  goal?: string;
  now?: Date;
  /** Whose run it was: a value typed straight from it becomes a profile value. */
  profile?: Profile | null;
}

/** One value the build guessed a source for: what the review shows and changes. */
export interface Guess {
  screen: string;
  /** The op's index in that screen. */
  op: number;
  label: string;
  /** What was typed or chosen; null for a secret, never shown. */
  typed: string | null;
  why: string;
  /** A select's values, when the page showed them: the choices if it's asked each run. */
  options?: string[];
}

export interface BuiltWalk {
  spec: WalkSpec;
  used: string[];
  skipped: { run: string; reason: string }[];
  /** Where the runs did different things on the same screen: the newest was kept. */
  disagreements: string[];
  /** Every fill and select, with where its value now comes from and why. */
  guesses: Guess[];
}

/** Two looks at least this alike (landmarks shared over all) on one URL are one page. */
const SAME_PAGE = 0.5;
/** Landmarks a screen is known by: enough to tell it apart, few enough to survive a tweak. */
const PICK = 4;
const MIN_PICK = 3;
const CAPTCHA_NOTE = /^solved a captcha here/;
/** explore's own note when a person acted unpaused (server.ts `helpedSince`): not a name. */
const HELPED_NOTE = /^a person did \d+ act\(s\) by hand here/;
/** A note this short names the screen that follows; a longer one describes it. */
const NAME_NOTE = 60;

const jaccard = (a: readonly string[], b: readonly string[]): number => {
  if (!a.length && !b.length) return 1;
  const B = new Set(b);
  const both = a.filter((x) => B.has(x)).length;
  return both / (new Set([...a, ...b]).size || 1);
};

export const samePage = (a: PageLook, b: PageLook): boolean =>
  a.url === b.url && jaccard(a.landmarks, b.landmarks) >= SAME_PAGE;

/** Every one of `landmarks` on the page, and the page on `url`. */
export const shows = (url: string | null, landmarks: readonly string[], look: PageLook): boolean =>
  (url === null || url === look.url) && landmarks.every((l) => look.landmarks.includes(l));

/** An op as the run did it, before values become fields or secrets. */
type RawOp =
  | { kind: "op"; act: Action }
  | { kind: "open"; url: string }
  | { kind: "captcha" }
  | { kind: "human"; reason: string };

/** What an op did, without its text: two runs agree on a screen when these match in order. */
const shapeOf = (r: RawOp): string =>
  r.kind === "op"
    ? `${r.act.kind} ${"target" in r.act && r.act.target ? describe(r.act.target) : ""}`.trim()
    : r.kind === "open"
      ? `open ${hostPath(r.url).split("?")[0]}`
      : r.kind;

interface Visit {
  run: string;
  look: PageLook;
  ops: RawOp[];
  /** A short note right before it: what the person called it. */
  named: string | null;
}

interface Cut {
  start: string | null;
  visits: Visit[];
  end: PageLook | null;
  /** Why the run cannot make a walk. */
  refused: string | null;
}

/** Acts that load a page by themselves. */
const LEADS = new Set(["click", "press", "submit", "select"]);
/** A load this soon after one is a redirect; this soon after a click, the click's. */
const REDIRECT_MS = 3_000;
const LED_MS = 10_000;

/** One run → its visits. Leading `open`s are where it starts; a pause is one human op. */
export function visitsOf(run: string, rows: readonly RunRow[]): Cut {
  const acts = rows.filter((r): r is Extract<RunRow, { kind: "act" }> => r.kind === "act");
  const ends = rows.filter((r): r is Extract<RunRow, { kind: "end" }> => r.kind === "end");
  const end = ends.at(-1)?.look ?? null;
  if (acts.some((r) => r.act.kind === "desktop"))
    return { start: null, visits: [], end, refused: "a desktop act (compile its recording)" };
  let start: string | null = null;
  const visits: Visit[] = [];
  let cur: Visit | null = null;
  let last: PageLook | null = null;
  let named: string | null = null;
  let paused: { notes: string[] } | null = null;
  // Taught by hand: a load no act led to is the address bar, an op of its own.
  const person = rows.some((r) => r.kind === "start" && r.driver === "person");
  let prevAt = 0;
  let prevKind = "";
  // Ops before any page was looked at (a person signed in by hand right after the start): the first visit does them first.
  const early: RawOp[] = [];
  const into = (op: RawOp) => {
    (cur ? cur.ops : early).push(op);
  };
  const visit = (look: PageLook) => {
    cur = { run, look, ops: early.splice(0), named };
    named = null;
    visits.push(cur);
  };
  for (const r of acts) {
    const a = r.act;
    if (a.kind === "pause") {
      if (r.look && (!cur || !last || !samePage(last, r.look))) visit(r.look);
      if (r.look) last = r.look;
      paused = { notes: [] };
      continue;
    }
    if (a.kind === "resume") {
      if (paused)
        into({
          kind: "human",
          reason: paused.notes.at(-1) ?? "a person acted here by hand (the run paused)",
        });
      paused = null;
      continue;
    }
    if (paused) {
      if (a.kind === "note") paused.notes.push(a.text);
      continue;
    }
    if (a.kind === "note") {
      if (CAPTCHA_NOTE.test(a.text)) {
        if (r.look && (!cur || !last || !samePage(last, r.look))) visit(r.look);
        if (r.look) last = r.look;
        into({ kind: "captcha" });
      } else if (!HELPED_NOTE.test(a.text)) named = a.text.trim();
      continue;
    }
    const at = Date.parse(r.at);
    const since = at - prevAt;
    const was = prevKind;
    prevAt = at;
    prevKind = a.kind;
    if (a.kind === "navigate") {
      // A person's click that loaded a page: the click is the op, not the load.
      // ponytail: by time alone; a click slower than LED_MS to load reads as the address bar.
      if (r.hand) {
        const led =
          (was === "navigate" && since < REDIRECT_MS) || (LEADS.has(was) && since < LED_MS);
        if (!person || led) continue;
        if (!cur) start = a.url;
        else into({ kind: "open", url: a.url });
        continue;
      }
      if (!cur) start = a.url;
      else into({ kind: "open", url: a.url });
      continue;
    }
    if (a.kind === "submit") continue;
    if (r.look && (!cur || !last || !samePage(last, r.look))) visit(r.look);
    if (r.look) last = r.look;
    if (!cur) {
      // A person's act before any command looked at a page: the page it was on starts the walk.
      start ??= a.url;
      continue;
    }
    into({ kind: "op", act: a });
  }
  start ??= acts.find((r) => r.act.kind !== "note")?.act.url ?? null;
  if (!visits.length) return { start, visits, end, refused: "no act on a page" };
  return { start, visits, end, refused: null };
}

const KIND_ORDER = (l: string) => (l.startsWith("heading ") ? 0 : l.startsWith("field ") ? 1 : 2);

/** Landmarks all of `looks` show, headings then fields then buttons. */
const common = (looks: readonly PageLook[]): string[] => {
  const [first, ...rest] = looks;
  if (!first) return [];
  return first.landmarks
    .filter((l) => rest.every((k) => k.landmarks.includes(l)))
    .sort((a, b) => KIND_ORDER(a) - KIND_ORDER(b));
};

const hostPath = (url: string): string => url.replace(/^[^/]*\/\/?/, "");

/** Build from runs already read: pure, for tests and for `buildWalk`. */
export function walkFromRuns(inputs: readonly RunInput[], o: BuildOptions): BuiltWalk {
  const skipped: { run: string; reason: string }[] = [];
  const cuts: { input: RunInput; cut: Cut }[] = [];
  for (const input of [...inputs].sort((a, b) =>
    a.summary.endedAt.localeCompare(b.summary.endedAt),
  )) {
    const cut = visitsOf(input.summary.run, input.rows);
    if (cut.refused) skipped.push({ run: input.summary.run, reason: cut.refused });
    else cuts.push({ input, cut });
  }
  const newest = cuts.at(-1);
  if (!newest)
    throw new Error(
      `no run can make ${o.name}${skipped.length ? `: ${skipped.map((s) => `${s.run} (${s.reason})`).join(", ")}` : ""}`,
    );

  // Cluster every visit by look; a visit joins the first cluster holding a page like it.
  const clusters: Visit[][] = [];
  const clusterOf = new Map<Visit, number>();
  for (const { cut } of cuts)
    for (const v of cut.visits) {
      let c = clusters.findIndex((members) => members.some((m) => samePage(m.look, v.look)));
      if (c < 0) c = clusters.push([]) - 1;
      clusters[c]?.push(v);
      clusterOf.set(v, c);
    }

  // A screen per cluster and visit number: the second time on a page is its own screen.
  type Key = string;
  const keysOf = (cut: Cut): { key: Key; visit: Visit }[] => {
    const seen = new Map<number, number>();
    return cut.visits.map((visit) => {
      const c = clusterOf.get(visit) as number;
      const k = seen.get(c) ?? 0;
      seen.set(c, k + 1);
      return { key: `${c}#${k}`, visit };
    });
  };
  const byRun = cuts.map(({ input, cut }) => ({ run: input.summary.run, keyed: keysOf(cut) }));
  const order: Key[] = [];
  const add = (k: Key) => {
    if (!order.includes(k)) order.push(k);
  };
  for (const { key } of byRun.at(-1)?.keyed ?? []) add(key);
  for (const r of byRun) for (const { key } of r.keyed) add(key);
  const visitsFor = (k: Key) =>
    byRun.flatMap((r) => r.keyed.filter((x) => x.key === k).map((x) => x.visit));

  // Landmarks: what the cluster's pages all show, and pages on the same URL do not.
  const pickFor = (c: number): string[] => {
    const members = clusters[c] as Visit[];
    const mine = common(members.map((m) => m.look));
    const url = members[0]?.look.url;
    const others = new Set(
      clusters.flatMap((o, i) =>
        i !== c && o[0]?.look.url === url ? common(o.map((m) => m.look)) : [],
      ),
    );
    const distinct = mine.filter((l) => !others.has(l));
    const pick = distinct.slice(0, PICK);
    for (const l of mine) if (pick.length < MIN_PICK && !pick.includes(l)) pick.push(l);
    return pick;
  };

  const disagreements: string[] = [];
  const fields: WalkField[] = [];
  const secrets: { key: string; label: string }[] = [];
  const fieldKey = (() => {
    const seen = new Map<string, number>();
    return (base: string): string => {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return n === 1 ? base : `${base}${n}`;
    };
  })();
  let irreversible = false;
  const names = new Map<Key, string>();
  const usedNames = new Set<string>();
  const nameFor = (k: Key, v: Visit): string => {
    const heading = v.look.landmarks.find((l) => l.startsWith("heading "))?.slice(8);
    const base =
      kebab(v.named && v.named.length <= NAME_NOTE ? v.named : (heading ?? hostPath(v.look.url))) ||
      "screen";
    let name = base;
    for (let n = 2; usedNames.has(name); n++) name = `${base}-${n}`;
    usedNames.add(name);
    names.set(k, name);
    return name;
  };

  const built = o.now ?? new Date();
  const mine = profileValues(o.profile ?? null);
  /** Why each op's value is what it is, by the op: the guesses the review shows. */
  const whys = new Map<object, { typed: string | null; why: string; options?: string[] }>();
  /**
   * A typed value, as the walk will get it (designs/2026-10-05-teach-mode.md):
   * a secret; else a profile value; else the same text in every run is fixed;
   * else a field, a date relative to the day, or what was typed as its default.
   */
  const sourceOf = (
    a: Extract<Action, { kind: "input" }>,
    others: readonly Action[],
  ): { value: WalkValue; typed: string | null; why: string } => {
    if (a.secret) {
      if (!secrets.some((s) => s.key === a.secret))
        secrets.push({ key: a.secret, label: describe(a.target) });
      return { value: { from: "secret", key: a.secret }, typed: null, why: "a stored secret" };
    }
    if (a.redacted) {
      const key = camel(describe(a.target)) || "secret";
      if (!secrets.some((s) => s.key === key)) secrets.push({ key, label: describe(a.target) });
      return { value: { from: "secret", key }, typed: null, why: "hidden as typed" };
    }
    const field = mine.find(([, v]) => same(v, a.value))?.[0];
    if (field)
      return {
        value: { from: "profile", field },
        typed: a.value,
        why: `your profile's ${field}`,
      };
    const fixed = others.some(
      (x) =>
        x.kind === "input" &&
        !x.redacted &&
        describe(x.target) === describe(a.target) &&
        x.value === a.value,
    );
    if (fixed)
      return {
        value: { from: "literal", text: a.value },
        typed: a.value,
        why: "the same each run",
      };
    const key = fieldKey(camel(fieldName(a.target)) || "value");
    const day = relativeDay(a.value, built);
    fields.push({
      key,
      label: fieldName(a.target),
      example: a.value,
      default: day ?? a.value,
    });
    return {
      value: { from: "plan", field: key },
      typed: a.value,
      why: day ? `a date: ${day}` : "may differ each run",
    };
  };

  const hintsOf = (t: LocatorHints): Hints => stripHints(t);
  const opsOf = (raw: readonly RawOp[], others: readonly Action[]): WalkOp[] =>
    raw.flatMap((r): WalkOp[] => {
      if (r.kind === "open")
        return [{ kind: "open", goal: `open ${hostPath(r.url).split("?")[0]}`, url: r.url }];
      if (r.kind === "captcha") return [{ kind: "captcha", goal: "solve the captcha" }];
      if (r.kind === "human") return [{ kind: "human", reason: r.reason }];
      const a = r.act;
      switch (a.kind) {
        case "click": {
          const hints = hintsOf(a.target);
          const label = `${a.target.name ?? ""} ${a.target.text ?? ""}`;
          const gated = IRREVERSIBLE_CLICK.test(label) || paymentGate("click", hints) !== null;
          irreversible ||= gated;
          return [
            { kind: "click", goal: `click ${describe(a.target)}`, hints, irreversible: gated },
          ];
        }
        case "input": {
          const hints = hintsOf(a.target);
          irreversible ||= paymentGate("fill", hints) !== null;
          const { value, typed, why } = sourceOf(a, others);
          const op: WalkOp = { kind: "fill", goal: `fill ${fieldName(a.target)}`, hints, value };
          whys.set(op, { typed, why });
          return [op];
        }
        case "select": {
          const hints = hintsOf(a.target);
          irreversible ||= paymentGate("select", hints) !== null;
          const op: WalkOp = { kind: "select", goal: `choose ${a.value}`, hints, value: a.value };
          whys.set(op, {
            typed: a.value,
            why: "a choice",
            ...(a.options?.length ? { options: a.options } : {}),
          });
          return [op];
        }
        case "press":
          return [{ kind: "press", goal: `press ${a.key}`, hints: hintsOf(a.target), key: a.key }];
        case "upload": {
          const key = fieldKey(`${camel(describe(a.target)) || "upload"}File`);
          fields.push({
            key,
            label: `file for ${describe(a.target)}`,
            example: a.files[0] ?? null,
          });
          return [
            {
              kind: "upload",
              goal: `upload to ${describe(a.target)}`,
              hints: hintsOf(a.target),
              file: { from: "plan", field: key },
            },
          ];
        }
        case "read":
          return [
            {
              kind: "read",
              goal: `read ${describe(a.target)}`,
              hints: hintsOf(a.target),
              as: a.as,
            },
          ];
        case "keep":
          return [{ kind: "keep", goal: `keep ${a.env}`, hints: hintsOf(a.target), env: a.env }];
        case "records":
          return [a.op];
        default:
          return [];
      }
    });

  const screens: ScreenSpec[] = [];
  for (const k of order) {
    const vs = visitsFor(k);
    const v = vs.at(-1) as Visit;
    const c = clusterOf.get(v) as number;
    const name = nameFor(k, v);
    const actsElsewhere = vs
      .slice(0, -1)
      .flatMap((x) => x.ops.flatMap((r) => (r.kind === "op" ? [r.act] : [])));
    const ops = opsOf(v.ops, actsElsewhere);
    const kept = v.ops.map(shapeOf);
    for (const x of vs.slice(0, -1)) {
      const theirs = x.ops.map(shapeOf);
      const at = theirs.findIndex((s, i) => s !== kept[i]);
      if (theirs.length === kept.length && at < 0) continue;
      const i = at < 0 ? Math.min(theirs.length, kept.length) : at;
      disagreements.push(
        `${name}: op ${i + 1} was "${theirs[i] ?? "nothing"}" in run ${x.run}, "${kept[i] ?? "nothing"}" in ${v.run}; kept ${v.run}'s`,
      );
    }
    const k0 = Number(k.split("#")[1]);
    const after = k0 > 0 ? [names.get(`${c}#${k0 - 1}`) as string] : [];
    screens.push({
      name,
      looks:
        v.named && v.named.length > NAME_NOTE
          ? v.named
          : `${v.look.landmarks.find((l) => l.startsWith("heading ")) ?? "a page"} on ${v.look.url}`,
      url: v.look.url,
      landmarks: pickFor(c),
      ops,
      ...(after.length ? { after } : {}),
      seen: new Set(vs.map((x) => x.run)).size,
    });
  }

  // Two screens one set of landmarks cannot tell apart: the later waits for the one before it in the newest run.
  const newestKeys = byRun.at(-1)?.keyed ?? [];
  for (const s of screens) {
    const clash = screens.some(
      (o) =>
        o !== s &&
        visitsFor([...names].find(([, n]) => n === o.name)?.[0] as Key).some((x) =>
          shows(s.url, s.landmarks, x.look),
        ),
    );
    if (!clash) continue;
    const i = newestKeys.findIndex(({ key }) => names.get(key) === s.name);
    const before = i > 0 ? names.get(newestKeys[i - 1]?.key as Key) : undefined;
    if (before && !s.after?.includes(before)) s.after = [...(s.after ?? []), before];
  }

  // The goal: the page the newest run ended on, by what every run that ended there showed.
  const lastScreen = names.get(newestKeys.at(-1)?.key as Key) as string;
  const endLook = newest.cut.end;
  const goalName = (() => {
    let n = kebab(o.name.replace(/^walk-/, "")) || "done";
    n = `${n}-done`;
    for (let i = 2; usedNames.has(n); i++) n = `${n.replace(/-\d+$/, "")}-${i}`;
    return n;
  })();
  if (endLook) {
    const alike = cuts.flatMap(({ cut }) =>
      cut.end && samePage(cut.end, endLook) ? [cut.end] : [],
    );
    for (const { input, cut } of cuts)
      if (cut.end && !samePage(cut.end, endLook))
        disagreements.push(
          `goal: run ${input.summary.run} ended on ${cut.end.url}, the newest on ${endLook.url}; kept the newest's`,
        );
    const mine = common(alike);
    const onTheWay = cuts.some(({ cut }) =>
      cut.visits.some((v) => shows(endLook.url, mine.slice(0, PICK), v.look)),
    );
    screens.unshift({
      name: goalName,
      looks: `${endLook.landmarks.find((l) => l.startsWith("heading ")) ?? "the page"} on ${endLook.url}`,
      url: endLook.url,
      landmarks: mine.slice(0, PICK),
      ops: [],
      goal: true,
      // A goal page also passed on the way (a dashboard) is the goal only once the walk is done there.
      ...(onTheWay ? { after: [lastScreen] } : {}),
      seen: alike.length,
    });
  } else
    screens.unshift({
      name: goalName,
      looks: "whatever page the last screen leads to",
      url: null,
      landmarks: [],
      ops: [],
      goal: true,
      after: [lastScreen],
      seen: 0,
    });

  // A value that came back in a URL the walk opens, or as the text of what it clicked: it follows the field.
  const byValue = fields.filter((f) => f.example && f.example.length >= 2);
  const inUrls = new Set<string>();
  for (const s of screens)
    s.ops = s.ops.map((op) => {
      if (op.kind === "open") {
        let url = op.url;
        for (const f of byValue) {
          const was = url;
          if (ID.test(f.example as string)) url = inUrl(url, f.example as string, f.key);
          if (url !== was) inUrls.add(f.key);
        }
        return url === op.url ? op : { ...op, url };
      }
      if (op.kind !== "click") return op;
      const f = byValue.find((x) => op.hints.text === x.example || op.hints.name === x.example);
      if (!f) return op;
      const hints = { ...op.hints };
      if (hints.text === f.example) hints.text = `{${f.key}}`;
      if (hints.name === f.example) hints.name = `{${f.key}}`;
      return { ...op, hints, goal: `click {${f.key}}` };
    });
  const guesses: Guess[] = screens.flatMap((s) =>
    s.ops.flatMap((op, i) => {
      const w = whys.get(op);
      if (!w || (op.kind !== "fill" && op.kind !== "select")) return [];
      const key = op.kind === "fill" && op.value.from === "plan" ? op.value.field : null;
      const why = key && inUrls.has(key) ? `an id in a URL it opens: ${w.why}` : w.why;
      const label = (op.kind === "select" ? op.hints.name : null) ?? labelOf(op);
      return [
        {
          screen: s.name,
          op: i,
          label,
          typed: w.typed,
          why,
          ...(w.options ? { options: w.options } : {}),
        },
      ];
    }),
  );

  const spec = walkSpecSchema.parse({
    version: WALK_VERSION,
    site: baseSite(o.site),
    name: o.name,
    goal: o.goal ?? newest.input.summary.goal ?? `${o.name} on ${baseSite(o.site)}`,
    built: (o.now ?? new Date()).toISOString(),
    from: cuts.map(({ input }) => ({
      run: input.summary.run,
      outcome: input.summary.outcome,
      endedAt: input.summary.endedAt,
    })),
    start: newest.cut.start,
    fields,
    secrets,
    irreversible,
    screens,
  } satisfies WalkSpec);
  return { spec, used: cuts.map((c) => c.input.summary.run), skipped, disagreements, guesses };
}

/** A profile's values by field, the longest first: a full name before a first name. */
function profileValues(p: Profile | null): [ProfileFieldName, string][] {
  if (!p) return [];
  return PROFILE_FIELDS.flatMap((f): [ProfileFieldName, string][] => {
    const v = profileField(p, f);
    return v && v.length >= 2 ? [[f, v]] : [];
  });
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** An id: one word with a digit in it. */
const ID = /^(?=.*\d)[\w-]{1,64}$/;

/** `value` as a whole path segment or query value of `url` becomes `{key}`. */
function inUrl(url: string, value: string, key: string): string {
  const v = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return url.replace(new RegExp(`([/=])${v}(?=[/?&#]|$)`, "g"), `$1%7B${key}%7D`);
}

/** What the review calls an op: the field it fills, or the choice it makes. */
const TYPE_NAMES: Record<string, string> = { email: "Email", tel: "Phone", url: "Website" };
/** A field's name; a placeholder standing in for one ("you@example.com") gives way to the input's type. */
export const fieldName = (t: LocatorHints): string => {
  const byType = TYPE_NAMES[t.inputType ?? ""];
  return byType && (!t.name || t.name === t.placeholder) ? byType : describe(t);
};

export const labelOf = (op: { goal: string }): string => op.goal.replace(/^(fill|choose) /, "");

/** A typed date as a day relative to `now` (`today+3d`); null when it is no date. */
export function relativeDay(typed: string, now: Date): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typed.trim());
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(typed.trim());
  const [y, m, d] = iso
    ? [iso[1], iso[2], iso[3]].map(Number)
    : us
      ? [us[3], us[1], us[2]].map(Number)
      : [];
  if (y === undefined || m === undefined || d === undefined || m < 1 || m > 12 || d < 1 || d > 31)
    return null;
  const day = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const n = Math.round((day - today) / 86_400_000);
  return `today${n < 0 ? "-" : "+"}${Math.abs(n)}d${us ? " MM/DD/YYYY" : ""}`;
}

/** Runs that can teach a walk: ended well, on this site. */
export const USABLE = new Set(["achieved", "saved"]);

/**
 * Build from the runs on disk: `runs` by id, or every usable run whose goal
 * has all of `goalLike`'s words. One of the two is required.
 */
export function buildWalk(
  runsDir: string,
  o: BuildOptions & { runs?: readonly string[]; goalLike?: string },
): BuiltWalk {
  if (!o.runs?.length && !o.goalLike)
    throw new Error("name the runs (--run) or a goal they share (--goal-like)");
  const site = baseSite(o.site);
  const words = (o.goalLike ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const all = listRuns(runsDir).filter((r) => baseSite(r.site) === site);
  const skipped: { run: string; reason: string }[] = [];
  for (const id of o.runs ?? [])
    if (!all.some((r) => r.run === id))
      skipped.push({ run: id, reason: `no ended run on ${site}` });
  const picked = all.filter((r) => {
    const named = o.runs?.includes(r.run) ?? false;
    const like = words.length > 0 && words.every((w) => (r.goal ?? "").toLowerCase().includes(w));
    if (!named && !like) return false;
    if (!USABLE.has(r.outcome)) {
      if (named) skipped.push({ run: r.run, reason: `ended ${r.outcome}` });
      return false;
    }
    return true;
  });
  const built = walkFromRuns(
    picked.map((summary) => ({
      summary,
      rows: readRun(runFile(runsDir, summary.site, summary.run)),
    })),
    o,
  );
  return { ...built, skipped: [...skipped, ...built.skipped] };
}
