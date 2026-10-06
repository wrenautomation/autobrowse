/**
 * A session's page calls (XHR, fetch, document loads) as redacted rows: what
 * an agent reads to find the JSON behind a page, diffs to see a site change,
 * and a failed flow leaves as evidence. Redaction runs before a row exists,
 * so nothing written or returned holds a header, cookie or token.
 * Design: designs/2026-10-06-network-capture.md.
 */
import type { BrowserContext, Response } from "playwright";
import { REDACTED, redactText } from "../recorder/redact.js";
import { urlShape } from "./screens.js";

/** A body is kept up to this. */
export const BODY_BYTES = 256 * 1024;
/** Rows a session keeps; past it the oldest go. */
export const MAX_ROWS = 2_000;
/** Body bytes a session keeps; past it new rows keep no body. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** One page's HTML is kept up to this. */
export const HTML_BYTES = 5 * 1024 * 1024;

/** Profiles that are a person's own account: calls kept, never their content. */
export const PERSONAL_PROFILES = ["x", "linkedin", "google"];

/** A header, query or JSON key with one of these words in its name holds a credential. */
const SECRET_WORDS = new Set(
  "token secret key apikey auth authorization session sessionid sid csrf xsrf signature sig cookie pass password passwd otp code pin ssn cvv cvc card credential credentials private jwt bearer dtsg lsd jazoest".split(
    " ",
  ),
);
/** `access_token`, `X-Api-Key`, `sessionId` → secret; `keyword`, `cardinality` are not. */
export const secretName = (name: string): boolean =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => SECRET_WORDS.has(w));
/** Headers worth keeping on a row; the rest add bytes and no signal. */
const KEEP_HEADERS =
  /^(content-type|accept|location|x-requested-with|x-fb-friendly-name|x-ig-app-id)$/i;
/** Resource types whose calls are rows. */
const CALL_TYPES = new Set(["xhr", "fetch", "document"]);
/** Content types whose body is text a reader can use. */
const TEXT_BODY = /json|text\/(plain|csv|xml)|xml|javascript-ld|graphql/i;

export interface NetRow {
  id: number;
  /** ms since the log started. */
  t: number;
  method: string;
  url: string;
  status: number;
  type: string;
  /** Kept request headers, redacted. */
  reqHeaders?: Record<string, string>;
  reqBody?: unknown;
  contentType?: string;
  /** Response bytes as sent (or the body's length when the header is missing). */
  size: number;
  /** The response: parsed JSON, or text; absent for a personal profile, a binary type, or past the caps. */
  body?: unknown;
  /** The body was longer than `BODY_BYTES` and cut. */
  cut?: boolean;
}

/** `x`, `linkedin@main` → personal; `x@wren` is not. `NETWORK_PERSONAL` (comma list) adds profiles. */
export function isPersonalProfile(site: string, env = process.env.NETWORK_PERSONAL): boolean {
  const extra = (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(site)) return true;
  const [base, label] = site.split("@");
  return PERSONAL_PROFILES.includes(base ?? "") && (!label || label === "main");
}

/** Headers kept (a short allow list), any secret-named one never. */
export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h))
    if (KEEP_HEADERS.test(k) && !secretName(k)) out[k.toLowerCase()] = redactText(v);
  return out;
}

/** Query values under secret names masked, the rest through `redactText`. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const [k, v] of [...u.searchParams])
      u.searchParams.set(k, secretName(k) ? REDACTED : redactText(v));
    return redactText(u.toString());
  } catch {
    return redactText(url);
  }
}

/** Every value under a secret-named key masked, every string through `redactText`, all levels. */
export function redactJson(v: unknown, depth = 0): unknown {
  if (depth > 40) return REDACTED;
  if (typeof v === "string") return redactText(v);
  if (Array.isArray(v)) return v.map((x) => redactJson(x, depth + 1));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        secretName(k) && x !== null && typeof x !== "object" ? REDACTED : redactJson(x, depth + 1),
      ]),
    );
  return v;
}

/** A body as text → JSON when it parses (form bodies as their fields), else the text; redacted. */
export function redactBody(text: string, contentType = ""): unknown {
  const t = text.trim();
  if (/^[[{]/.test(t)) {
    try {
      return redactJson(JSON.parse(t));
    } catch {
      // Not JSON after all: text.
    }
  }
  if (/x-www-form-urlencoded/i.test(contentType)) {
    const form = new URLSearchParams(t);
    return Object.fromEntries(
      [...form].map(([k, v]) => [k, secretName(k) ? REDACTED : redactText(v)]),
    );
  }
  return redactText(text);
}

/** Up to three levels of key paths, arrays as `[]`: a response's shape without its values. */
export function keyPaths(v: unknown, prefix = "", depth = 0, out = new Set<string>()): Set<string> {
  if (depth >= 3 || v === null || typeof v !== "object") return out;
  if (Array.isArray(v)) {
    const first = v.find((x) => x && typeof x === "object");
    if (first) keyPaths(first, `${prefix}[]`, depth, out);
    return out;
  }
  for (const [k, x] of Object.entries(v)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.add(p);
    keyPaths(x, p, depth + 1, out);
  }
  return out;
}

/** `GET host/path` → the key paths seen on its responses. */
export type Shapes = Map<string, Set<string>>;

export function shapes(rows: readonly NetRow[]): Shapes {
  const out: Shapes = new Map();
  for (const r of rows) {
    if (r.type === "document") continue;
    const k = `${r.method} ${urlShape(r.url)}`;
    const keys = out.get(k) ?? new Set<string>();
    keyPaths(r.body, "", 0, keys);
    out.set(k, keys);
  }
  return out;
}

export interface ShapeDiff {
  added: string[];
  gone: string[];
  /** Calls on both sides whose response keys changed. */
  changed: { call: string; added: string[]; gone: string[] }[];
}

export function diffShapes(before: Shapes, after: Shapes): ShapeDiff {
  const added = [...after.keys()].filter((k) => !before.has(k));
  const gone = [...before.keys()].filter((k) => !after.has(k));
  const changed: ShapeDiff["changed"] = [];
  for (const [call, keys] of after) {
    const was = before.get(call);
    if (!was) continue;
    const a = [...keys].filter((k) => !was.has(k));
    const g = [...was].filter((k) => !keys.has(k));
    if (a.length || g.length) changed.push({ call, added: a, gone: g });
  }
  return { added, gone, changed };
}

/** Rows back from a written `jsonl()`; lines that do not parse are skipped. */
export function parseRows(text: string): NetRow[] {
  const out: NetRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as NetRow);
    } catch {
      // A torn last line from a killed session.
    }
  }
  return out;
}

/** One row as a line: `12 GET 200 host/path 3.1kB {data,paging}`. */
export function rowLine(r: NetRow): string {
  const kb = r.size >= 1024 ? `${(r.size / 1024).toFixed(1)}kB` : `${r.size}B`;
  const top =
    r.body && typeof r.body === "object" && !Array.isArray(r.body)
      ? ` {${Object.keys(r.body).slice(0, 6).join(",")}}`
      : Array.isArray(r.body)
        ? ` [${r.body.length}]`
        : "";
  return `${r.id} ${r.method} ${r.status} ${urlShape(r.url)}${r.type === "document" ? " (page)" : ""} ${kb}${top}`;
}

export interface NetLogOptions {
  /** The profile (`x@wren`): a personal one keeps no content. */
  site: string;
  personal?: boolean;
  /** Rows kept; the oldest go first. */
  maxRows?: number;
  /** Body bytes kept across the kept rows; past it a new row keeps no body. */
  maxBodyBytes?: number;
  /** Each row as it is made: a session appends it to its file. */
  onRow?(row: NetRow): void;
  now?(): number;
}

const attached = new WeakMap<BrowserContext, NetLog>();

/** One session's calls, from `attach` until the context closes. */
export class NetLog {
  private list: NetRow[] = [];
  /** Body bytes each kept row holds, in step with `list`. */
  private held: number[] = [];
  private bytes = 0;
  private next = 1;
  private readonly t0: number;
  private readonly now: () => number;
  readonly personal: boolean;

  constructor(private readonly o: NetLogOptions) {
    this.now = o.now ?? Date.now;
    this.t0 = this.now();
    this.personal = o.personal ?? isPersonalProfile(o.site);
  }

  /** Listens on the whole context: popups and new tabs are in the log too. */
  static attach(context: BrowserContext, o: NetLogOptions): NetLog {
    const log = new NetLog(o);
    context.on("response", (r) => {
      void log.take(r).catch(() => undefined);
    });
    return log;
  }

  /** The context's log, attached on first ask: a parked browser that serves many runs has one. */
  static of(context: BrowserContext, o: NetLogOptions): NetLog {
    const had = attached.get(context);
    if (had) return had;
    const log = NetLog.attach(context, o);
    attached.set(context, log);
    return log;
  }

  rows(): NetRow[] {
    return [...this.list];
  }

  row(id: number): NetRow | undefined {
    return this.list.find((r) => r.id === id);
  }

  /** The last `n` rows as JSON lines. */
  jsonl(n = this.list.length): string {
    return this.list
      .slice(-n)
      .map((r) => `${JSON.stringify(r)}\n`)
      .join("");
  }

  /** A response as a row; exported for the tests' fakes. */
  async take(r: Response): Promise<NetRow | null> {
    const req = r.request();
    const type = req.resourceType();
    if (!CALL_TYPES.has(type)) return null;
    const url = req.url();
    if (!/^https?:/.test(url)) return null;
    const headers = r.headers();
    const contentType = headers["content-type"] ?? "";
    const row: NetRow = {
      id: this.next++,
      t: this.now() - this.t0,
      method: req.method(),
      url: this.personal ? (url.split(/[?#]/)[0] ?? url) : redactUrl(url),
      status: r.status(),
      type,
      size: Number(headers["content-length"] ?? 0) || 0,
    };
    if (!this.personal) {
      row.reqHeaders = redactHeaders(req.headers());
      const posted = req.postData();
      if (posted)
        row.reqBody = redactBody(posted.slice(0, BODY_BYTES), req.headers()["content-type"]);
      if (contentType) row.contentType = contentType.split(";")[0] ?? contentType;
      // A document's HTML is the page saves' job; a redirect has no body.
      const bodied =
        type !== "document" &&
        TEXT_BODY.test(contentType) &&
        (r.status() < 300 || r.status() >= 400);
      if (bodied && this.bytes < (this.o.maxBodyBytes ?? MAX_BODY_BYTES)) {
        const text = await r.text().catch(() => null);
        if (text !== null) {
          if (!row.size) row.size = Buffer.byteLength(text);
          const kept = text.length > BODY_BYTES ? text.slice(0, BODY_BYTES) : text;
          if (kept !== text) row.cut = true;
          row.body = redactBody(kept, contentType);
        }
      }
    }
    const bytes = row.body === undefined ? 0 : JSON.stringify(row.body).length;
    this.list.push(row);
    this.held.push(bytes);
    this.bytes += bytes;
    while (this.list.length > (this.o.maxRows ?? MAX_ROWS)) {
      this.list.shift();
      this.bytes -= this.held.shift() ?? 0;
    }
    this.o.onRow?.(row);
    return row;
  }
}

/** A page's HTML for a file: scripts' bodies out (they hold tokens and add bytes), redacted, capped. */
export function htmlForFile(html: string): string {
  const lean = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) =>
      m.replace(/>[\s\S]*<\/script>$/i, "></script>"),
    )
    .replace(
      /(<input\b[^>]*\btype=["']?(password|hidden)["']?[^>]*\bvalue=)(["'])[^"']*\3/gi,
      `$1$3${REDACTED}$3`,
    );
  const out = redactText(lean);
  return out.length > HTML_BYTES ? out.slice(0, HTML_BYTES) : out;
}

/** Lines added and removed between two saves of one page (tags on their own lines first). */
export function diffHtml(before: string, after: string): { added: string[]; removed: string[] } {
  const lines = (h: string) =>
    h
      .replace(/></g, ">\n<")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const count = (ls: string[]) => {
    const m = new Map<string, number>();
    for (const l of ls) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = count(lines(before));
  const b = count(lines(after));
  const added: string[] = [];
  const removed: string[] = [];
  for (const [l, n] of b) for (let i = a.get(l) ?? 0; i < n; i++) added.push(l);
  for (const [l, n] of a) for (let i = b.get(l) ?? 0; i < n; i++) removed.push(l);
  return { added, removed };
}
