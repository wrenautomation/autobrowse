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
import type { Action, LocatorHints, Recording } from "../recorder/types.js";
import type { Outline, OutlineField, OutlineOp, OutlineStep } from "./outline.js";

export const IRREVERSIBLE_CLICK =
  /\b(buy|purchase|pay|checkout|complete (order|purchase)|place order|confirm|create|generate|register|delete|remove|revoke|deploy|send|publish|submit)\b/i;
export const IRREVERSIBLE_COMMAND =
  /^(rm|rmdir|terraform (apply|destroy)|tofu (apply|destroy)|aws .* (delete|create|put)|gh (repo|release) (create|delete)|git push|kubectl (apply|delete)|docker (rm|rmi))\b/;

type BrowserStep = Extract<OutlineStep, { kind: "browser" }>;

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

/** Unique names: `name`, `name-2`, `name-3`. */
function uniquer() {
  const seen = new Map<string, number>();
  return (base: string): string => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
}

function stripHints(h: LocatorHints): Hints {
  // Keep only what locates; the compiled flow does not need the element's href.
  const { href: _href, ...rest } = h;
  return rest;
}

export function structure(rec: Recording): Outline {
  const fields: OutlineField[] = [];
  const secrets: Outline["secrets"] = [];
  const fieldKey = uniquer();
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
      c.irreversible = c.ops.some((o) => o.kind === "click" && o.irreversible);
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
  const add = (op: OutlineOp) => open().ops.push(op);

  for (const a of rec.actions as Action[]) {
    switch (a.kind) {
      case "navigate":
        if (cur()?.ops.length) close();
        pendingUrl = a.url;
        break;
      case "note":
        close();
        pendingName = kebab(a.text);
        pendingDescription = a.text;
        break;
      case "pause":
        add({ kind: "human", reason: "recording was paused here: a private step" });
        break;
      case "resume":
        break;
      case "click":
        add({
          kind: "click",
          goal: `click ${describe(a.target)}`,
          hints: stripHints(a.target),
          irreversible: IRREVERSIBLE_CLICK.test(`${a.target.name ?? ""} ${a.target.text ?? ""}`),
        });
        break;
      case "input": {
        const label = describe(a.target);
        const key = fieldKey(camel(label));
        if (a.redacted) {
          secrets.push({ key, label });
          add({
            kind: "fill",
            goal: `fill ${label}`,
            hints: stripHints(a.target),
            value: { from: "secret", key },
          });
        } else {
          fields.push({ key, label, example: a.value });
          add({
            kind: "fill",
            goal: `fill ${label}`,
            hints: stripHints(a.target),
            value: { from: "plan", field: key },
          });
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
      case "submit":
        // Follows the click or Enter that caused it.
        break;
    }
  }
  close();

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

  return {
    name: rec.name,
    site: rec.site,
    description: `Recorded ${rec.startedAt.slice(0, 10)} on ${rec.site}`,
    fields,
    secrets,
    steps,
  };
}
