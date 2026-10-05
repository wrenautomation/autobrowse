/**
 * The records op at run time: the page's markup is copied into a sandbox (a
 * headless page of its own with every request refused, so no cookies, no
 * network, no navigation) and the kept extractor runs there. Its rows are
 * checked; a feed scrolls the real page for more. Code a model wrote never
 * runs in a signed-in page. Writing one is src/agent/records.ts.
 */
import type { Page } from "playwright";
import type { OutlineOp } from "../compiler/outline.js";
import type { FlowPage } from "./flow.js";
import { scrollCollect } from "./scroll-collect.js";

export type RecordsOp = Extract<OutlineOp, { kind: "records" }>;
export type Row = Record<string, string | null>;

/** A required field is filled on at least this share of rows, or the code missed it. */
const FILLED = 0.8;
/** One value at most this long: a row is a record, not a page. */
const VALUE_CAP = 4_000;
const SANDBOX_MS = 15_000;

/** The page as markup a sandbox can load: scripts out, a base so relative links resolve. */
export async function snapshot(page: Page): Promise<string> {
  const html = (await page.content()).replace(/<script\b[\s\S]*?<\/script>/gi, "");
  const base = `<base href="${page.url().replace(/"/g, "&quot;")}">`;
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (h) => `${h}${base}`)
    : `${base}${html}`;
}

/**
 * Evaluate `expr` over `html` in a fresh headless browser that refuses every
 * request. ponytail: a browser per call (~0.5s); keep one open if feeds get long.
 */
export async function inSandbox<T>(html: string, expr: string): Promise<T> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const timer = setTimeout(() => void browser.close().catch(() => undefined), SANDBOX_MS);
  try {
    const page = await browser.newPage();
    await page.route("**/*", (r) => r.abort());
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: SANDBOX_MS });
    return (await page.evaluate(expr)) as T;
  } catch (err) {
    if (!browser.isConnected()) throw new Error(`the code ran past ${SANDBOX_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => undefined);
  }
}

/** The code's rows, values as trimmed strings or null; only the declared fields. */
export async function runExtractor(html: string, op: Pick<RecordsOp, "code" | "fields">) {
  // A string evaluate: a page's CSP that blocks eval does not apply to it.
  const expr = `(() => {
    const rows = (function (root) {\n${op.code}\n})(document);
    if (!Array.isArray(rows)) return { notRows: rows === null ? "null" : typeof rows };
    return rows.map((r) => Object.fromEntries(Object.entries(r && typeof r === "object" ? r : {})
      .map(([k, v]) => [k, v == null || typeof v === "object" ? null : String(v)])));
  })()`;
  const got = await inSandbox<Row[] | { notRows: string }>(html, expr);
  if (!Array.isArray(got)) throw new Error(`the code returned ${got.notRows}, not an array`);
  return got.map((r): Row => {
    const row: Row = {};
    for (const f of op.fields) {
      const v = r[f.key]?.replace(/\s+/g, " ").trim().slice(0, VALUE_CAP);
      row[f.key] = v ? v : null;
    }
    return row;
  });
}

/** What is wrong with these rows, or null: none, fewer than the floor, required fields empty. */
export function checkRows(rows: Row[], op: Pick<RecordsOp, "fields" | "min">): string | null {
  if (!rows.length) return "no rows";
  if (rows.length < op.min) return `${rows.length} rows, fewer than the ${op.min} it used to read`;
  for (const f of op.fields) {
    if (f.optional) continue;
    const empty = rows.filter((r) => !r[f.key]).length;
    if (rows.length - empty < rows.length * FILLED)
      return `${f.key} is empty on ${empty} of ${rows.length} rows`;
  }
  return null;
}

/** Rows by the key field, first seen kept; a row with no key is its whole content. */
const keyOf = (op: Pick<RecordsOp, "key">) => (r: Row) => r[op.key] ?? JSON.stringify(r);

export function dedupe(rows: Row[], op: Pick<RecordsOp, "key">): Row[] {
  const seen = new Map<string, Row>();
  for (const r of rows) if (!seen.has(keyOf(op)(r))) seen.set(keyOf(op)(r), r);
  return [...seen.values()];
}

/** The op's rows on this page: one read, or a feed scrolled up to `max`. The last markup comes back too. */
export async function readRecords(
  fp: FlowPage,
  op: RecordsOp,
): Promise<{ rows: Row[]; html: string }> {
  let html = "";
  const read = async () => {
    html = await snapshot(fp.page);
    return runExtractor(html, op);
  };
  if (!op.max) return { rows: dedupe(await read(), op), html };
  const { rows } = await scrollCollect(fp, { read, key: keyOf(op), max: op.max });
  return { rows, html };
}
