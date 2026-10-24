/**
 * The second scrub, at Wren (designs/2026-10-24-shared-library.md): each file in the ingest's
 * `inbox/` goes through Presidio (Microsoft, MIT, run here in Docker), and only then to
 * `kept/`. A trace was scrubbed on its machine already; this pass catches what pattern and
 * known-value scrubs cannot know: names, places and numbers in page text.
 * Strings are batched: one `/analyze` call per chunk of joined strings, spans mapped back.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { strFromU8, zipSync } from "fflate";
import { type Pass, rewriteTrace } from "./scrub.js";
import { SHARE_URL } from "./share.js";

const run = promisify(execFile);

export const PRESIDIO_IMAGE = "mcr.microsoft.com/presidio-analyzer:2.2.362";
const CONTAINER = "autobrowse-presidio";
const PORT = 5002;

/**
 * What is masked, and from what score. LOCATION only when Presidio is sure. No IP_ADDRESS:
 * the first scrub masks IPv4, and Presidio read version numbers as addresses.
 */
const ENTITIES: Record<string, number> = {
  PERSON: 0.6,
  EMAIL_ADDRESS: 0.5,
  PHONE_NUMBER: 0.5,
  CREDIT_CARD: 0.5,
  IBAN_CODE: 0.5,
  US_SSN: 0.5,
  US_PASSPORT: 0.6,
  US_DRIVER_LICENSE: 0.6,
  US_BANK_NUMBER: 0.6,
  LOCATION: 0.85,
};

/** Joins strings for one call; a line of its own, so no entity spans two strings. */
const SEP = "\n⁣\n";
const CHUNK = 40_000;

export type Analyze = (
  text: string,
) => Promise<{ entity_type: string; start: number; end: number; score: number }[]>;

/** Presidio's REST `/analyze` on the local container. */
export const presidioAt =
  (base = `http://127.0.0.1:${PORT}`): Analyze =>
  async (text) => {
    const rsp = await fetch(`${base}/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, language: "en", entities: Object.keys(ENTITIES) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!rsp.ok) throw new Error(`presidio ${rsp.status}`);
    return (await rsp.json()) as Awaited<ReturnType<Analyze>>;
  };

/** Start the container when it is down, and wait for it to answer. */
export async function presidioUp(): Promise<Analyze> {
  const base = `http://127.0.0.1:${PORT}`;
  const alive = () =>
    fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }).then(
      (r) => r.ok,
      () => false,
    );
  if (await alive()) return presidioAt(base);
  await run("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
  await run("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-p",
    `127.0.0.1:${PORT}:3000`,
    "--memory",
    "2g",
    PRESIDIO_IMAGE,
  ]);
  for (let i = 0; i < 90; i++) {
    if (await alive()) return presidioAt(base);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("presidio did not start in 90 s");
}

export async function presidioDown(): Promise<void> {
  await run("docker", ["stop", CONTAINER]).catch(() => undefined);
}

/** Each distinct string masked by `analyze`, batched. */
export async function maskAll(
  strings: Iterable<string>,
  analyze: Analyze,
): Promise<Map<string, string>> {
  const all = [...new Set(strings)].filter((s) => /[A-Za-z0-9]{2}/.test(s));
  const todo = all.filter((s) => s.length <= CHUNK);
  const out = new Map<string, string>();
  // A long string (a CSS file, a page's text) goes in pieces cut at white space or `;`.
  for (const long of all.filter((s) => s.length > CHUNK)) {
    const pieces: string[] = [];
    for (let at = 0; at < long.length; ) {
      let end = Math.min(at + CHUNK, long.length);
      if (end < long.length) {
        const cut = Math.max(
          long.lastIndexOf(" ", end - 1),
          long.lastIndexOf(";", end - 1),
          long.lastIndexOf("\n", end - 1),
        );
        if (cut > at + CHUNK / 2) end = cut + 1;
      }
      pieces.push(long.slice(at, end));
      at = end;
    }
    const m = await maskAll(pieces, analyze);
    const masked = pieces.map((x) => m.get(x) ?? x).join("");
    if (masked !== long) out.set(long, masked);
  }
  let batch: string[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const text = batch.join(SEP);
    const spans = (await analyze(text))
      .filter((h) => h.score >= (ENTITIES[h.entity_type] ?? 1))
      .sort((a, b) => a.start - b.start);
    let at = 0;
    for (const s of batch) {
      const end = at + s.length;
      let masked = "";
      let cur = at;
      for (const h of spans) {
        if (h.end <= cur || h.start >= end) continue;
        const from = Math.max(h.start, cur);
        masked += `${text.slice(cur, from)}<${h.entity_type.toLowerCase()}>`;
        cur = Math.min(h.end, end);
      }
      masked += text.slice(cur, end);
      if (masked !== s) out.set(s, masked);
      at = end + SEP.length;
    }
    batch = [];
    size = 0;
  };
  for (const s of todo) {
    if (size + s.length > CHUNK) await flush();
    batch.push(s);
    size += s.length + SEP.length;
  }
  await flush();
  return out;
}

/** A trace zip with every kept string through Presidio. */
export async function presidioTrace(zip: Uint8Array, analyze: Analyze): Promise<Uint8Array> {
  const seen: string[] = [];
  const collect: Pass = {
    text: (s) => {
      seen.push(s);
      return s;
    },
    url: (s) => {
      seen.push(s);
      return s;
    },
  };
  rewriteTrace(zip, collect);
  const masked = await maskAll(seen, analyze);
  const apply = (s: string) => masked.get(s) ?? s;
  return zipSync(rewriteTrace(zip, { text: apply, url: apply }), { level: 6 });
}

/** A flow pack (JSON) with every string value through Presidio. */
export async function presidioJson(body: string, analyze: Analyze): Promise<string> {
  const seen: string[] = [];
  const walk = (v: unknown, f: (s: string) => string): unknown =>
    typeof v === "string"
      ? f(v)
      : Array.isArray(v)
        ? v.map((x) => walk(x, f))
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f)]))
          : v;
  const doc = JSON.parse(body) as unknown;
  walk(doc, (s) => {
    seen.push(s);
    return s;
  });
  const masked = await maskAll(seen, analyze);
  return JSON.stringify(walk(doc, (s) => masked.get(s) ?? s));
}

/** The ingest's admin routes (bearer SHARE_ADMIN_TOKEN). */
export function shareAdmin(token: string, base = SHARE_URL, f: typeof fetch = fetch) {
  const call = async (method: string, path: string, body?: Uint8Array | string) => {
    const rsp = await f(`${base}/admin/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: typeof body === "string" ? body : Buffer.from(body) } : {}),
    });
    if (!rsp.ok) throw new Error(`share admin ${method} ${path.split("/")[0]}: ${rsp.status}`);
    return rsp;
  };
  const obj = (key: string) => `object/${encodeURIComponent(key)}`;
  return {
    async list(prefix: string): Promise<{ key: string; size: number }[]> {
      const out: { key: string; size: number }[] = [];
      let cursor: string | null = null;
      do {
        const q = new URLSearchParams({ prefix, ...(cursor ? { cursor } : {}) });
        const page = (await (await call("GET", `list?${q}`)).json()) as {
          keys: { key: string; size: number }[];
          cursor: string | null;
        };
        out.push(...page.keys);
        cursor = page.cursor;
      } while (cursor);
      return out;
    },
    get: async (key: string) => new Uint8Array(await (await call("GET", obj(key))).arrayBuffer()),
    put: async (key: string, body: Uint8Array | string) => void (await call("PUT", obj(key), body)),
    delete: async (key: string) => void (await call("DELETE", obj(key))),
  };
}

export type ShareAdmin = ReturnType<typeof shareAdmin>;

/**
 * Move the inbox to `kept/` through Presidio: `inbox/<day>/<install>/<kind>/<name>` becomes
 * `kept/<kind>/<day>/<install>/<name>`. A file Presidio cannot read is deleted, never kept raw.
 */
export async function keepInbox(
  admin: ShareAdmin,
  analyze: Analyze,
  limit = 200,
): Promise<{ kept: number; bad: number; left: number }> {
  const all = await admin.list("inbox/");
  let kept = 0;
  let bad = 0;
  for (const { key } of all.slice(0, limit)) {
    const [, day, install, kind, name] = key.split("/");
    if (!day || !install || !name || (kind !== "traces" && kind !== "flows")) {
      await admin.delete(key);
      bad++;
      continue;
    }
    const raw = await admin.get(key);
    let clean: Uint8Array | string;
    try {
      clean =
        kind === "traces"
          ? await presidioTrace(raw, analyze)
          : await presidioJson(strFromU8(raw), analyze);
    } catch (err) {
      if ((err as Error).message.startsWith("presidio")) throw err;
      await admin.delete(key);
      bad++;
      continue;
    }
    await admin.put(`kept/${kind}/${day}/${install}/${name}`, clean);
    await admin.delete(key);
    kept++;
  }
  return { kept, bad, left: Math.max(0, all.length - limit) };
}

/**
 * One round: list, start Presidio only when there is work, keep up to `limit`, stop it.
 * A trace takes about 100 s (a real Workday trace, 2026-10-24), so a round is capped.
 */
export async function keepShared(token: string, limit = 30, base = SHARE_URL) {
  const admin = shareAdmin(token, base);
  if (!(await admin.list("inbox/")).length) return { kept: 0, bad: 0, left: 0 };
  const analyze = await presidioUp();
  try {
    return await keepInbox(admin, analyze, limit);
  } finally {
    await presidioDown();
  }
}
