/**
 * Secrets out of a local Playwright trace, in place (designs/2026-10-24-trace-secrets.md).
 * The trace stays whole for debugging: frames, bodies, typed text that is no secret.
 *
 * A secret is a value held by this process (`secrets.ts`) or the value of a secret field
 * (a password, a one-time code, a card) in any DOM snapshot. Then:
 * - secret fields lose their value in every snapshot, prefixes and all;
 * - a keyboard run (one key per call, as Hands types) whose text holds a secret loses
 *   every key it typed, slips too;
 * - every string that holds a secret, raw or encoded, in events, network rows and text
 *   bodies, has it masked;
 * - cookie and authorization headers lose their values.
 * Then each secret is searched for again. A hit is counted, never a reason to drop the
 * trace. The scrub is idempotent: a scrubbed trace comes back unchanged.
 */
import { readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import { strFromU8, strToU8, unzipSync, type Zippable, zipSync } from "fflate";
import { escapeRe, forms, type Json } from "../share/scrub.js";
import { heldSecrets, MATCH_MIN } from "./secrets.js";

export const SECRET_MARK = "<secret>";

export interface SecretScrub {
  /** Secret values found in the trace's own fields. */
  found: number;
  /** Field values, keys, strings and header values masked. */
  masked: number;
  /** Secret forms still in the written text: should be 0. */
  leaks: number;
  changed: boolean;
}

/** `autocomplete` tokens of fields that hold a secret. */
const SECRET_FILL = /^(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp.*)$/;
const VALUE_ATTRS = ["__playwright_value_", "value"];
const SECRET_HEADERS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization"]);
/** Keyboard calls a run is made of, and the calls that come between keys of one run. */
const KEY_CALLS = new Set([
  "keyboardType",
  "keyboardInsertText",
  "keyboardPress",
  "keyboardDown",
  "keyboardUp",
]);
const PAUSE_CALLS = new Set(["waitForTimeout", "mouseMove"]);
/** Keys that end what is typed into one field. */
const LEAVE_KEYS = new Set(["Enter", "Tab"]);

type Obj = { [k: string]: Json };
const isObj = (v: Json | undefined): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function secretField(tag: string, attrs: Obj): boolean {
  if (tag !== "INPUT") return false;
  if (typeof attrs.type === "string" && attrs.type.toLowerCase() === "password") return true;
  return (
    typeof attrs.autocomplete === "string" &&
    attrs.autocomplete
      .toLowerCase()
      .split(/\s+/)
      .some((t) => SECRET_FILL.test(t))
  );
}

/** Each element of a snapshot node tree: `[tag, attrs?, ...children]`; text and back refs skipped. */
function elements(n: Json, f: (tag: string, attrs: Obj) => void): void {
  if (!Array.isArray(n) || typeof n[0] !== "string") return;
  const attrs = n[1];
  if (isObj(attrs)) f(n[0], attrs);
  for (const c of n.slice(isObj(attrs) ? 2 : 1)) elements(c, f);
}

const snapshotHtml = (e: Obj): Json | undefined =>
  e.type === "frame-snapshot" && isObj(e.snapshot) ? e.snapshot.html : undefined;

function parseLines(body: string): Obj[] {
  const out: Obj[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (isObj(o)) out.push(o);
    } catch {
      // a cut-off last line
    }
  }
  return out;
}

const textOf = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/** The text a keyboard run left in its field: keys in order, Backspace taking one back. */
function runs(events: Obj[], f: (keys: Obj[], text: string) => void): void {
  let keys: Obj[] = [];
  let text: string[] = [];
  const close = () => {
    if (keys.length) f(keys, text.join(""));
    keys = [];
    text = [];
  };
  for (const e of events) {
    if (e.type !== "before" || typeof e.method !== "string") continue;
    if (PAUSE_CALLS.has(e.method)) continue;
    if (!KEY_CALLS.has(e.method)) {
      close();
      continue;
    }
    keys.push(e);
    const p = isObj(e.params) ? e.params : {};
    if (typeof p.text === "string") text.push(...p.text);
    if (e.method === "keyboardPress" && typeof p.key === "string") {
      if (p.key === "Backspace") text.pop();
      else if (LEAVE_KEYS.has(p.key)) close();
    }
  }
  close();
}

/** The trace with its secrets masked; `null` when there was nothing to mask. */
export function scrubSecrets(
  zip: Uint8Array,
  held: Iterable<string> = heldSecrets(),
): { zip: Uint8Array | null; report: SecretScrub } {
  const files = unzipSync(zip);
  const parsed = new Map<string, Obj[]>();
  for (const [name, bytes] of Object.entries(files))
    if (name.endsWith(".trace") || name.endsWith(".network"))
      parsed.set(name, parseLines(strFromU8(bytes)));

  const report: SecretScrub = { found: 0, masked: 0, leaks: 0, changed: false };
  // 1. Secret fields: their values are secrets; each value goes, whatever it holds.
  const found = new Set<string>();
  for (const events of parsed.values())
    for (const e of events)
      elements(snapshotHtml(e) ?? null, (tag, attrs) => {
        if (!secretField(tag, attrs)) return;
        for (const k of VALUE_ATTRS) {
          const v = attrs[k];
          if (typeof v !== "string" || !v || v === SECRET_MARK) continue;
          found.add(v);
          attrs[k] = SECRET_MARK;
          report.masked++;
        }
      });
  report.found = found.size;
  const secrets = [...new Set([...held, ...found])].filter((s) => s && s !== SECRET_MARK);
  const whole = new Set(secrets);
  const parts = secrets.filter((s) => s.length >= MATCH_MIN).flatMap(forms);
  const re = parts.length
    ? new RegExp(
        [...new Set(parts)]
          .sort((a, b) => b.length - a.length)
          .map(escapeRe)
          .join("|"),
        "g",
      )
    : null;
  const holds = (s: string) => whole.has(s) || (re !== null && s.search(re) >= 0);
  const text = (s: string): string => {
    if (whole.has(s)) {
      report.masked++;
      return SECRET_MARK;
    }
    if (!re || s.search(re) < 0) return s;
    report.masked++;
    return s.replace(re, SECRET_MARK);
  };

  // 2. Keyboard runs that typed a secret: every key goes, and each call's log lines.
  const hidden = new Set<Json>();
  for (const [name, events] of parsed) {
    if (!name.endsWith(".trace")) continue;
    runs(events, (keys, typed) => {
      if (!holds(typed)) return;
      for (const k of keys) {
        const p = isObj(k.params) ? k.params : null;
        if (p && typeof p.text === "string" && p.text !== SECRET_MARK) {
          p.text = SECRET_MARK;
          report.masked++;
        }
        hidden.add(k.callId ?? null);
      }
    });
  }

  // 3. Every string: secrets masked; secret headers and cookies lose their values.
  const deep = (v: Json, key = ""): Json => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = deep(v[i] as Json);
      return v;
    }
    if (!isObj(v)) return v;
    const header = typeof v.name === "string" && typeof v.value === "string";
    if (header && (key === "cookies" || SECRET_HEADERS.has((v.name as string).toLowerCase()))) {
      if (v.value && v.value !== SECRET_MARK) {
        v.value = SECRET_MARK;
        report.masked++;
      }
      return v;
    }
    for (const [k, x] of Object.entries(v))
      v[k] = Array.isArray(x) ? x.map((y) => deep(y, k)) : deep(x, k);
    return v;
  };
  for (const events of parsed.values())
    for (const e of events) {
      if (e.type === "log" && hidden.has(e.callId ?? null) && e.message !== SECRET_MARK) {
        e.message = SECRET_MARK;
        report.masked++;
      }
      deep(e);
    }

  const out: Zippable = {};
  const checks: string[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    const events = parsed.get(name);
    if (events) {
      const body = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
      checks.push(body);
      out[name] = [strToU8(body), { level: 6 }];
      continue;
    }
    // Screen frames and images are pixels: a field shows dots, never its value.
    const body = name.startsWith("resources/") && re ? textOf(bytes) : null;
    if (body !== null && body.search(re as RegExp) >= 0) {
      report.masked++;
      const clean = body.replace(re as RegExp, SECRET_MARK);
      checks.push(clean);
      out[name] = [strToU8(clean), { level: 6 }];
    } else out[name] = [bytes, { level: 0 }];
  }
  if (re) for (const body of checks) report.leaks += body.match(re)?.length ?? 0;
  report.changed = report.masked > 0;
  return { zip: report.changed ? zipSync(out) : null, report };
}

/**
 * Scrub the trace at `path` in place: a temp file, then a rename, so a stop midway
 * leaves the old file whole. Its mtime is kept, so the sweep ages it as before.
 */
export async function scrubSecretsFile(
  path: string,
  held: Iterable<string> = heldSecrets(),
): Promise<SecretScrub> {
  const before = await stat(path);
  const { zip, report } = scrubSecrets(await readFile(path), held);
  if (!zip) return report;
  const tmp = `${path}.scrub-tmp`;
  await writeFile(tmp, zip);
  await rename(tmp, path);
  await utimes(path, before.atime, before.mtime);
  return report;
}
