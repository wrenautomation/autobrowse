/**
 * Recording → outline, deterministically. Steps split at notes (the
 * person named what comes next) and at navigations after some gesture (a
 * new page is a new step). Typed text becomes a plan field keyed by the
 * field's label; redacted text becomes a secret fetched by key. A click
 * whose label spends money or creates something is irreversible, and so
 * is its step. A pause becomes a `human` op: the recorder saw nothing
 * there on purpose.
 */
import type { Hints } from "../browser/locate.js";
import { INTERACTIVE_COMMANDS } from "../deps/shell.js";
import { paymentGate } from "../gates/payment.js";
import type { Action, LocatorHints, Recording } from "../recorder/types.js";
import type { Known } from "../share/scrub.js";
import {
  type DesktopOutlineOp,
  HINT_TEXTS,
  type Outline,
  type OutlineField,
  type OutlineOp,
  type OutlineStep,
  PLACEHOLDER,
} from "./outline.js";

export const IRREVERSIBLE_CLICK =
  /\b(buy|purchase|pay|checkout|complete (order|purchase)|place order|confirm|create|generate|register|delete|remove|revoke|deploy|send|publish|submit)\b/i;
export const IRREVERSIBLE_COMMAND =
  /^(rm|rmdir|terraform (apply|destroy)|tofu (apply|destroy)|aws .* (delete|create|put)|gh (repo|release) (create|delete)|git push|kubectl (apply|delete)|docker (rm|rmi))\b/;

type BrowserStep = Extract<OutlineStep, { kind: "browser" }>;
type DesktopStep = Extract<OutlineStep, { kind: "desktop" }>;

/** Longest step name; a note is a sentence, a name is a handle. Cut at a word. */
const NAME_MAX = 40;

export const kebab = (s: string): string => {
  const full =
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[^a-z]+/, "") || "step";
  if (full.length <= NAME_MAX) return full;
  const cut = full.lastIndexOf("-", NAME_MAX);
  return cut > 0 ? full.slice(0, cut) : full.slice(0, NAME_MAX);
};

export const camel = (s: string): string => {
  const k = kebab(s);
  return k.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
};

/** The word a person would use for the element. */
export function describe(h: LocatorHints): string {
  return h.name ?? h.placeholder ?? h.text ?? h.testId ?? h.id ?? h.tag;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.hostname : u.pathname;
  } catch {
    return url;
  }
}

/** More than a handful of words, or a full stop inside: a thought, not a handle. */
const isSentence = (s: string): boolean => s.trim().split(/\s+/).length > 5 || /[.!?]\s+\S/.test(s);

/** Unique names: `name`, `name-2`, `name-3`. */
/** Unique names: `base`, then `base-2`; with `sep` "" a field key stays an identifier (`base2`). */
function uniquer(sep = "-") {
  const seen = new Map<string, number>();
  return (base: string): string => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}${sep}${n}`;
  };
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

/**
 * A name that carries the account's current state ("Contact info
 * jin@x.com", "Phone (587) 555-0100") would not match once that state
 * changes: keep the label before it as a loose prefix match, the way a
 * hand-written hint would.
 */
export function looseName(name: string): string {
  const m = name.match(EMAIL);
  if (!m || m.index === undefined) return name;
  const label = name.slice(0, m.index).trim();
  if (!label) return name;
  return `/^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`;
}

export function stripHints(h: LocatorHints): Hints {
  // Keep only what locates; the compiled flow does not need the element's href.
  const { href: _href, ...rest } = h;
  return rest.name ? { ...rest, name: looseName(rest.name) } : rest;
}

/** Verifying and observing words in an agent's thought: it is looking, not doing. */
const LOOK_AROUND =
  /\b(verif\w*|confirm\w*|check(ing|ed|s)?|make sure|ensur\w*|see (the|whether|if)|look(ing)? at|already|still|show(s|ing|ed)?|appears?|indicat\w*|listed|displayed)\b/i;
const DISMISS = /^(close|back|cancel|ok|okay|done|got it|not now|dismiss)$/i;

/**
 * An agent that met the goal looks around to be sure: it re-opens the
 * page, clicks into what it changed, closes it again. Trailing steps after
 * the last one that changed anything are dropped when each is clicks only
 * and either described in looking words or made of clicks on controls
 * the flow already clicked (re-opening) and dismissals.
 */
export function dropLookAround(steps: OutlineStep[]): OutlineStep[] {
  const changes = (s: OutlineStep) =>
    s.kind === "terminal" ||
    s.kind === "desktop" ||
    s.ops.some((o) => o.kind !== "click" || o.irreversible);
  let last = -1;
  steps.forEach((s, i) => {
    if (changes(s)) last = i;
  });
  if (last < 0) return steps;
  const seen = new Set<string>();
  for (const s of steps.slice(0, last + 1))
    if (s.kind === "browser")
      for (const o of s.ops) if (o.kind === "click") seen.add(JSON.stringify(o.hints));
  const tail = steps.slice(last + 1);
  const churn = tail.every(
    (s) =>
      s.kind === "browser" &&
      s.ops.every((o) => o.kind === "click") &&
      (LOOK_AROUND.test(s.description) ||
        s.ops.every(
          (o) =>
            o.kind === "click" &&
            (seen.has(JSON.stringify(o.hints)) || DISMISS.test(o.hints.name ?? "")),
        )),
  );
  return churn ? steps.slice(0, last + 1) : steps;
}

export interface StructureOptions {
  /**
   * Values the recording is known to carry that are the person's, not the site's: the account's
   * username (`kind: "account"`). A hint or URL that shows one reads `{field}` instead
   * (designs/2026-10-24-operator-defaults.md).
   */
  known?: readonly Known[];
}

export function structure(rec: Recording, o: StructureOptions = {}): Outline {
  const fields: OutlineField[] = [];
  const secrets: Outline["secrets"] = [];
  const fieldKey = uniquer("");
  const stepName = uniquer();
  const steps: OutlineStep[] = [];

  // Assigned inside closures, so TS narrows it wrongly at use sites; read via `cur()`.
  let current: BrowserStep | null = null;
  const cur = (): BrowserStep | null => current;
  let pendingName: string | null = null;
  let pendingDescription: string | null = null;
  let pendingUrl: string | null = null;

  const close = () => {
    const c = cur();
    if (c?.ops.length) {
      // A step that touches billing waits for the person, whatever its click says.
      c.irreversible = c.ops.some(
        (o) =>
          (o.kind === "click" && o.irreversible) ||
          ((o.kind === "fill" || o.kind === "select" || o.kind === "click") &&
            paymentGate(o.kind, o.hints) !== null),
      );
      steps.push(c);
    }
    current = null;
  };
  const open = (): BrowserStep => {
    const c = cur();
    if (c) return c;
    const base = pendingName ?? (pendingUrl ? kebab(pathOf(pendingUrl)) : "step");
    current = {
      kind: "browser",
      name: stepName(base),
      description: pendingDescription ?? (pendingUrl ? `on ${pathOf(pendingUrl)}` : ""),
      irreversible: false,
      proof: null,
      url: pendingUrl,
      ops: [],
    };
    pendingName = pendingDescription = null;
    return current;
  };
  /**
   * Add an op; a fill or select on a control already filled or selected in
   * this step replaces that earlier op (the last value entered is the one
   * that counts: a retyped field, a form re-entered after a reload).
   */
  const add = (op: OutlineOp, again = false) => {
    const ops = open().ops;
    // The same control clicked again right away is a retry (a menu that had not opened yet), not two
    // clicks, unless the journal says the first one changed the page.
    const last = ops.at(-1);
    if (
      !again &&
      op.kind === "click" &&
      last?.kind === "click" &&
      JSON.stringify(last.hints) === JSON.stringify(op.hints)
    )
      return;
    if (op.kind === "fill" || op.kind === "select") {
      const same = JSON.stringify(op.hints);
      const i = ops.findIndex(
        (o) =>
          o.kind === op.kind &&
          (JSON.stringify(o.hints) === same ||
            (o.kind === "fill" &&
              op.kind === "fill" &&
              o.value.from === "secret" &&
              op.value.from === "secret" &&
              o.value.key === op.value.key)),
      );
      if (i >= 0) {
        ops.splice(i, 1);
      }
    }
    ops.push(op);
  };

  // Desktop acts in a row make one desktop step; a browser act after closes it.
  let desktop: DesktopStep | null = null;
  const curDesktop = (): DesktopStep | null => desktop;
  const closeDesktop = () => {
    const d = curDesktop();
    if (d?.ops.length) {
      d.irreversible = d.ops.some(
        (o) => (o.kind === "click" && o.irreversible) || (o.kind === "shell" && o.root),
      );
      steps.push(d);
    }
    desktop = null;
  };
  const addDesktop = (op: DesktopOutlineOp) => {
    let d = curDesktop();
    if (!d) {
      close();
      d = desktop = {
        kind: "desktop",
        name: stepName(pendingName ?? "desktop"),
        description: pendingDescription ?? "on the desktop",
        irreversible: false,
        proof: null,
        ops: [],
      };
      pendingName = pendingDescription = null;
    }
    d.ops.push(op);
  };

  for (const a of rec.actions as Action[]) {
    if (a.kind !== "desktop" && a.kind !== "note") closeDesktop();
    switch (a.kind) {
      case "desktop": {
        const op = a.op;
        switch (op.op) {
          case "open":
            addDesktop({ kind: "open", goal: `open ${op.app}`, app: op.app });
            break;
          case "click":
            addDesktop({
              kind: "click",
              goal: `click ${op.role ?? "control"} "${op.name}"`,
              app: op.app ?? null,
              role: op.role ?? null,
              name: op.name,
              irreversible: IRREVERSIBLE_CLICK.test(op.name),
            });
            break;
          case "type": {
            const label = `typed text ${(curDesktop()?.ops.filter((o) => o.kind === "type").length ?? 0) + 1}`;
            const key = fieldKey(camel(label));
            if (a.redacted) secrets.push({ key, label });
            else fields.push({ key, label, example: op.text });
            addDesktop({
              kind: "type",
              goal: `type ${label}`,
              value: a.redacted ? { from: "secret", key } : { from: "plan", field: key },
            });
            break;
          }
          case "key":
            addDesktop({ kind: "key", goal: `press ${op.combo}`, combo: op.combo });
            break;
          case "shell":
            addDesktop({
              kind: "shell",
              goal: `run ${op.command.split(/\s+/)[0] ?? "command"}`,
              command: op.command,
              root: op.root ?? false,
            });
            break;
          case "wait":
            addDesktop({ kind: "wait", goal: `wait ${op.ms}ms`, ms: op.ms });
            break;
          // Looking is not a step: apps, tree, shot.
          case "apps":
          case "tree":
          case "shot":
            break;
        }
        break;
      }
      case "navigate":
        if (cur()?.ops.length) close();
        pendingUrl = a.url;
        break;
      case "note":
        close();
        closeDesktop();
        // Each flow opens a new tab: the next step starts on the page the note was on, not the last navigate.
        if (a.url) pendingUrl = a.url;
        // A short note is a name ("Checkout"); a sentence (an agent's thought) describes the step, and the page names it.
        pendingName = isSentence(a.text)
          ? pendingUrl
            ? kebab(pathOf(pendingUrl))
            : null
          : kebab(a.text);
        pendingDescription = a.text;
        break;
      case "pause":
        add({ kind: "human", reason: "recording was paused here: a private step" });
        break;
      case "resume":
        break;
      case "click":
        add(
          {
            kind: "click",
            goal: `click ${describe(a.target)}`,
            hints: stripHints(a.target),
            irreversible: IRREVERSIBLE_CLICK.test(`${a.target.name ?? ""} ${a.target.text ?? ""}`),
          },
          a.again === true,
        );
        break;
      case "input": {
        const label = describe(a.target);
        const hints = stripHints(a.target);
        // A retyped field keeps its key and takes the new value as its example;
        // a secret placed again in this step (the control renamed itself) is the same fill.
        const prior = open().ops.find(
          (o) =>
            o.kind === "fill" &&
            (JSON.stringify(o.hints) === JSON.stringify(hints) ||
              (a.secret !== undefined && o.value.from === "secret" && o.value.key === a.secret)),
        );
        const priorKey =
          prior?.kind === "fill" && prior.value.from !== "literal"
            ? prior.value.from === "plan"
              ? prior.value.field
              : prior.value.key
            : null;
        // A placed secret keeps its own name (email, password, code); a typed value is named by its label.
        const key = priorKey ?? fieldKey(a.secret ?? camel(label));
        if (a.redacted) {
          if (!secrets.some((s) => s.key === key)) secrets.push({ key, label });
          add({ kind: "fill", goal: `fill ${label}`, hints, value: { from: "secret", key } });
        } else {
          const f = fields.find((f) => f.key === key);
          if (f) f.example = a.value;
          else fields.push({ key, label, example: a.value });
          add({ kind: "fill", goal: `fill ${label}`, hints, value: { from: "plan", field: key } });
        }
        break;
      }
      case "select":
        add({
          kind: "select",
          goal: `select ${a.value} in ${describe(a.target)}`,
          hints: stripHints(a.target),
          value: a.value,
        });
        break;
      case "press":
        if (a.key === "Enter")
          add({
            kind: "press",
            goal: `press Enter in ${describe(a.target)}`,
            hints: stripHints(a.target),
            key: a.key,
          });
        break;
      case "hover":
        add({
          kind: "hover",
          goal: `hover over ${describe(a.target)}`,
          hints: stripHints(a.target),
        });
        break;
      case "upload": {
        const label = describe(a.target);
        const key = fieldKey(camel(label));
        fields.push({ key, label, example: a.files[0] ?? null });
        add({
          kind: "upload",
          goal: `upload to ${label}`,
          hints: stripHints(a.target),
          file: { from: "plan", field: key },
        });
        break;
      }
      case "read":
        add({
          kind: "read",
          goal: `read ${describe(a.target)} as ${a.as}`,
          hints: stripHints(a.target),
          as: a.as,
        });
        break;
      case "records":
        // Render refuses it by name: a list read replays in a walk, not compiled code.
        add(a.op);
        break;
      case "code":
        // The code reads `plan.<key>`: the field keeps that key, never a uniquer's.
        for (const [key, example] of Object.entries(a.plan)) {
          const f = fields.find((f) => f.key === key);
          if (f) f.example = example;
          else fields.push({ key, label: `${key} for the code`, example });
        }
        add({
          kind: "code",
          goal: `code into ${a.as}`,
          as: a.as,
          code: a.code,
          plan: Object.keys(a.plan),
        });
        break;
      case "keep":
        add({
          kind: "keep",
          goal: `keep ${describe(a.target)} as ${a.env}`,
          hints: stripHints(a.target),
          env: a.env,
        });
        break;
      case "submit":
        // Follows the click or Enter that caused it.
        break;
      case "eval":
      case "download":
        // No outline op replays a script or a fetch: a walk does (`walks cut`).
        add({ kind: "human", reason: `a ${a.kind} acted here: build this run as a walk` });
        break;
      case "cut":
        break;
    }
  }
  close();
  closeDesktop();

  if (rec.commands.length) {
    const interactive = rec.commands.filter((c) => INTERACTIVE_COMMANDS.test(c));
    steps.push({
      kind: "terminal",
      name: stepName("terminal"),
      description: interactive.length
        ? `shell commands; ${interactive.length} need a person (${interactive.join(", ")})`
        : "shell commands",
      irreversible: rec.commands.some((c) => IRREVERSIBLE_COMMAND.test(c)),
      proof: null,
      commands: rec.commands,
    });
  }

  const kept = dropLookAround(steps);
  placeholders(kept, fields, rec.site, o.known ?? []);
  // Only what an op still reads (a browser fill or a desktop type), after replaced fills dropped theirs;
  // a step URL's or a hint's `{field}` counts too.
  const used = new Set<string>();
  const named = (text: string) => {
    for (const m of text.matchAll(PLACEHOLDER)) used.add(m[1] as string);
  };
  for (const s of kept) {
    if (s.kind === "terminal") continue;
    if (s.kind === "browser" && s.url) named(s.url);
    for (const op of s.ops) {
      if (s.kind === "browser" && "hints" in op)
        for (const k of HINT_TEXTS) if (typeof op.hints[k] === "string") named(op.hints[k]);
      if ("file" in op && op.file.from === "plan") used.add(op.file.field);
      if (op.kind === "code") for (const f of op.plan) used.add(f);
      if (!("value" in op) || typeof op.value !== "object") continue;
      if (op.value.from === "secret") used.add(op.value.key);
      if (op.value.from === "plan") used.add(op.value.field);
    }
  }
  return {
    name: rec.name,
    site: rec.site,
    description: `Recorded ${rec.startedAt.slice(0, 10)} on ${rec.site}`,
    fields: fields.filter((f) => used.has(f.key)),
    secrets: secrets.filter((f) => used.has(f.key)),
    steps: kept,
  };
}

/** A value shorter than this is too common a string to stand in for. */
const PLACEHOLDER_MIN = 3;

/**
 * The person's values in what the page showed: a typed value (a handle, a
 * name) that the next page repeats in a control's label or in the URL, or the
 * account's own username. Each becomes `{field}` so the compiled flow reads it
 * from the plan; the username's field is `account`, added when a hint needs it.
 * A hint already loosened to a regex is left alone (its personal part is gone).
 */
function placeholders(
  steps: OutlineStep[],
  fields: OutlineField[],
  site: string,
  known: readonly Known[],
): void {
  const stand: { value: string; key: string }[] = fields
    .filter((f) => f.example !== null && f.example.length >= PLACEHOLDER_MIN)
    .map((f) => ({ value: f.example as string, key: f.key }));
  const account = known.find((k) => k.kind === "account" && k.value.length >= PLACEHOLDER_MIN);
  let accountKey: string | null = fields.find((f) => f.example === account?.value)?.key ?? null;
  const accountField = (): string => {
    if (accountKey) return accountKey;
    accountKey = fields.some((f) => f.key === "account") ? "account" : "account";
    if (!fields.some((f) => f.key === accountKey))
      fields.push({
        key: accountKey,
        label: `The ${site} account the flow runs as`,
        example: account?.value ?? null,
      });
    return accountKey;
  };
  const swap = (text: string): string => {
    if (/^\/.*\/i?$/.test(text)) return text;
    let out = text;
    for (const s of [...stand].sort((a, b) => b.value.length - a.value.length))
      if (out.includes(s.value)) out = out.split(s.value).join(`{${s.key}}`);
    if (account && out.includes(account.value))
      out = out.split(account.value).join(`{${accountField()}}`);
    return out;
  };
  // A URL holds the value encoded (`a%20b`, or `a+b` from a form); the rendered flow encodes it back.
  const urlSwap = (url: string): string => {
    let out = swap(url);
    for (const s of [...stand].sort((a, b) => b.value.length - a.value.length))
      for (const v of new Set([
        encodeURIComponent(s.value),
        encodeURIComponent(s.value).replace(/%20/g, "+"),
      ]))
        if (out.includes(v)) out = out.split(v).join(`{${s.key}}`);
    return out;
  };
  // A step named after a URL path that holds the value: the field's key stands in (`acmeco-home` → `handle-home`).
  const nameSwap = (name: string): string => {
    let out = name;
    for (const s of stand)
      if (out.includes(kebab(s.value))) out = out.split(kebab(s.value)).join(s.key.toLowerCase());
    return out;
  };
  for (const step of steps) {
    if (step.kind !== "browser") continue;
    if (step.url) step.url = urlSwap(step.url);
    step.name = nameSwap(step.name);
    step.description = swap(step.description);
    for (const op of step.ops) {
      if ("goal" in op) op.goal = swap(op.goal);
      if (!("hints" in op)) continue;
      for (const k of HINT_TEXTS) {
        const v = op.hints[k];
        if (typeof v === "string") op.hints[k] = swap(v);
      }
    }
  }
}
