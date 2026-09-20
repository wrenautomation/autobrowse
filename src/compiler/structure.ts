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
import type { DesktopOutlineOp, Outline, OutlineField, OutlineOp, OutlineStep } from "./outline.js";

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

  return {
    name: rec.name,
    site: rec.site,
    description: `Recorded ${rec.startedAt.slice(0, 10)} on ${rec.site}`,
    fields,
    secrets,
    steps,
  };
}
