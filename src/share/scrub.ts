/**
 * A Playwright trace with the personal data taken out, made on the machine
 * before a trace is shared (designs/2026-10-24-shared-library.md). Written
 * against trace format 9 (Playwright 1.63).
 *
 * Kept: actions, DOM snapshots, network method/host/path/status, CSS.
 * Dropped: screen frames, screenshots, images, response bodies, headers,
 * cookies, post data, query values, stacks, console args, launch paths.
 * Masked: every known value (what the run typed, the profile's fields),
 * input values, and the `redactPii` patterns. Then each known value is
 * searched for again, raw and encoded; one hit throws `ScrubLeak`.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { redactPii } from "../recorder/redact.js";

/** A value the run knows is personal, and the mark it becomes (`typed`, `email`). */
export interface Known {
  value: string;
  kind: string;
}

export class ScrubLeak extends Error {
  constructor(readonly kind: string) {
    super(`scrubbed trace still holds a ${kind} value`);
  }
}

/**
 * A short value (a year, "Java") matches dates, ids and plain words, not a
 * person. Typed ones are masked by place anyway.
 */
function personal(value: string): boolean {
  const v = value.trim();
  return /^\d+$/.test(v) ? v.length >= 7 : v.length >= 5;
}

const INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const VALUE_ATTRS = new Set(["value", "__playwright_value_"]);
/** SVG geometry: numbers only, never personal, and they read as phone numbers. */
const SHAPE_ATTRS = new Set(["d", "points", "viewBox", "transform"]);
const URL_ATTRS = new Set(["href", "src", "__playwright_current_src__", "action", "srcset"]);
/** Action params that carry what was typed or uploaded. */
const TYPED_PARAMS = new Set(["value", "text", "values", "localPaths", "files", "payloads"]);

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Each way a value shows in a trace: raw, URL-encoded, form-encoded, JSON- and HTML-escaped. */
export function forms(value: string): string[] {
  const out = new Set([
    value,
    encodeURIComponent(value),
    encodeURIComponent(value).replace(/%20/g, "+"),
    JSON.stringify(value).slice(1, -1),
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/ /g, "&nbsp;"),
  ]);
  return [...out];
}

/** What a pass does to each string: `url` for URL-shaped ones, `text` for the rest. */
export interface Pass {
  text(s: string): string;
  url(s: string): string;
}

interface Scrubber extends Pass {
  check(text: string): void;
}

function scrubber(known: Known[]): Scrubber {
  const usable = known.filter((k) => personal(k.value));
  // Longest first: a full name goes before the first name inside it.
  const swaps = usable
    .flatMap((k) => forms(k.value).map((f) => ({ f, mark: `<${k.kind}>` })))
    .sort((a, b) => b.f.length - a.f.length)
    .map(({ f, mark }) => ({ re: new RegExp(escapeRe(f), "gi"), mark }));
  const probes = usable.flatMap((k) =>
    forms(k.value).map((f) => ({ f: f.toLowerCase(), kind: k.kind })),
  );
  const text = (s: string): string => {
    let out = s;
    for (const { re, mark } of swaps) out = out.replace(re, mark);
    return redactPii(out);
  };
  const url = (s: string): string => {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return text(s);
    }
    if (u.protocol === "data:" || u.protocol === "blob:") return `${u.protocol}<dropped>`;
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, "<q>");
    u.hash = "";
    u.username = "";
    u.password = "";
    const plain = u.toString();
    try {
      return text(decodeURIComponent(plain));
    } catch {
      return text(plain);
    }
  };
  const check = (body: string): void => {
    const lower = body.toLowerCase();
    for (const { f, kind } of probes) if (lower.includes(f)) throw new ScrubLeak(kind);
  };
  return { text, url, check };
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Every string in a value, through `text`; keys that carry typed input become `<typed>`. */
function deep(v: Json, s: Pass, key = ""): Json {
  if (TYPED_PARAMS.has(key) && v !== null && typeof v !== "boolean" && typeof v !== "number")
    return "<typed>";
  if (typeof v === "string") return /url$/i.test(key) ? s.url(v) : s.text(v);
  if (Array.isArray(v)) return v.map((x) => deep(x, s));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, s, k)]));
  return v;
}

/**
 * A snapshot node: a text string, a back reference `[[n, m]]`, or
 * `[tag, attrs?, ...children]`. Input values become `<input>`; a
 * textarea's text the same.
 */
function node(n: Json, s: Pass, parentTag = ""): Json {
  if (typeof n === "string") return parentTag === "TEXTAREA" ? "<input>" : s.text(n);
  if (!Array.isArray(n) || n.length === 0 || typeof n[0] !== "string") return n;
  const tag = n[0];
  const rest = n.slice(1);
  const out: Json[] = [tag];
  const attrs = rest[0];
  if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
    rest.shift();
    out.push(
      Object.fromEntries(
        Object.entries(attrs).map(([k, v]) => {
          if (typeof v !== "string" || SHAPE_ATTRS.has(k)) return [k, v];
          if (VALUE_ATTRS.has(k) && (INPUT_TAGS.has(tag) || k !== "value")) return [k, "<input>"];
          return [k, URL_ATTRS.has(k) ? s.url(v) : s.text(v)];
        }),
      ),
    );
  }
  for (const c of rest) out.push(node(c, s, tag));
  return out;
}

const LAUNCH_KEYS = new Set([
  "userDataDir",
  "args",
  "executablePath",
  "env",
  "proxy",
  "storageState",
]);

function event(o: { [k: string]: Json }, s: Pass): { [k: string]: Json } | null {
  switch (o.type) {
    case "screencast-frame":
      return null;
    case "frame-snapshot": {
      const snap = o.snapshot as { [k: string]: Json };
      return {
        ...o,
        snapshot: {
          ...snap,
          frameUrl: typeof snap.frameUrl === "string" ? s.url(snap.frameUrl) : null,
          html: node(snap.html as Json, s),
        },
      };
    }
    case "before": {
      if (o.method === "screenshot") return { ...o, params: {} };
      return { ...o, params: deep(o.params as Json, s) };
    }
    case "console":
      return { ...o, args: [], text: typeof o.text === "string" ? s.text(o.text) : "" };
    case "context-options": {
      const opts = (o.options ?? {}) as { [k: string]: Json };
      return {
        ...o,
        options: deep(
          Object.fromEntries(Object.entries(opts).filter(([k]) => !LAUNCH_KEYS.has(k))),
          s,
        ),
      };
    }
    default:
      return deep(o, s) as { [k: string]: Json };
  }
}

/** A network row: method, URL without query values, status, and the CSS body pointer only. */
function resource(o: { [k: string]: Json }, s: Pass, css: Set<string>): { [k: string]: Json } {
  const snap = (o.snapshot ?? {}) as { [k: string]: Json };
  const req = (snap.request ?? {}) as { [k: string]: Json };
  const rsp = (snap.response ?? {}) as { [k: string]: Json };
  const content = (rsp.content ?? {}) as { [k: string]: Json };
  const mime = typeof content.mimeType === "string" ? content.mimeType : "";
  const sha = typeof content._sha1 === "string" ? content._sha1 : null;
  const keepBody = sha !== null && /^text\/css\b/.test(mime);
  if (keepBody) css.add(sha);
  return {
    type: o.type ?? "resource-snapshot",
    snapshot: {
      pageref: snap.pageref ?? null,
      startedDateTime: snap.startedDateTime ?? null,
      time: snap.time ?? null,
      timings: snap.timings ?? {},
      _frameref: snap._frameref ?? null,
      _monotonicTime: snap._monotonicTime ?? null,
      request: {
        method: req.method ?? "GET",
        url: typeof req.url === "string" ? s.url(req.url) : "",
        httpVersion: req.httpVersion ?? "",
        headers: [],
        cookies: [],
        queryString: [],
        headersSize: -1,
        bodySize: -1,
      },
      response: {
        status: rsp.status ?? 0,
        statusText: rsp.statusText ?? "",
        httpVersion: rsp.httpVersion ?? "",
        headers: [],
        cookies: [],
        content: keepBody
          ? { mimeType: mime, size: content.size ?? 0, _sha1: sha }
          : { mimeType: mime, size: 0 },
        redirectURL: "",
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
    },
  };
}

function lines(
  body: string,
  f: (o: { [k: string]: Json }) => { [k: string]: Json } | null,
): string {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let o: { [k: string]: Json };
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a cut-off last line
    }
    const kept = f(o);
    if (kept) out.push(JSON.stringify(kept));
  }
  return `${out.join("\n")}\n`;
}

/**
 * The trace with each kept string through `p`, and what holds pixels or
 * bodies dropped. A scrubbed trace passes through unchanged but for `p`:
 * the second pass at Wren (`share/presidio`) uses this on one.
 */
export function rewriteTrace(zip: Uint8Array, p: Pass): Record<string, Uint8Array> {
  const files = unzipSync(zip);
  const out: Record<string, Uint8Array> = {};
  const css = new Set<string>();
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith(".network"))
      out[name] = strToU8(lines(strFromU8(bytes), (o) => resource(o, p, css)));
  }
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith(".trace")) out[name] = strToU8(lines(strFromU8(bytes), (o) => event(o, p)));
  }
  for (const sha of css) {
    const bytes = files[`resources/${sha}`];
    if (bytes) out[`resources/${sha}`] = strToU8(p.text(strFromU8(bytes)));
  }
  return out;
}

/** The trace zip with personal data out. Throws `ScrubLeak` when a known value survives. */
export function scrubTrace(zip: Uint8Array, known: Known[]): Uint8Array {
  const s = scrubber(known);
  const out = rewriteTrace(zip, s);
  for (const bytes of Object.values(out)) s.check(strFromU8(bytes));
  return zipSync(out, { level: 6 });
}

/** Plain text (a flow's source, a proof line) with personal data out. Throws `ScrubLeak` like `scrubTrace`. */
export function scrubText(body: string, known: Known[]): string {
  const s = scrubber(known);
  const out = s.text(body);
  s.check(out);
  return out;
}

/** Protocol methods whose params carry what the run typed, and the param. */
const TYPED_BY: Record<string, string> = {
  fill: "value",
  type: "text",
  keyboardType: "text",
  keyboardInsertText: "text",
  pressSequentially: "text",
};

/** Every value the run typed, read from the raw trace's own action params: sign-ins included. */
export function knownFromTrace(zip: Uint8Array): Known[] {
  const trace = unzipSync(zip, { filter: (f) => f.name.endsWith(".trace") });
  const out = new Map<string, Known>();
  for (const bytes of Object.values(trace))
    for (const line of strFromU8(bytes).split("\n")) {
      if (!line.includes('"before"')) continue;
      try {
        const o = JSON.parse(line) as {
          type?: string;
          method?: string;
          params?: Record<string, unknown>;
        };
        const param = o.type === "before" && o.method ? TYPED_BY[o.method] : undefined;
        const v = param ? o.params?.[param] : undefined;
        if (typeof v === "string" && v.trim()) out.set(v, { value: v, kind: "typed" });
      } catch {
        // a cut-off last line
      }
    }
  return [...out.values()];
}
