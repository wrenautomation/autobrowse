/**
 * Writing a records op: a model reads rows off the page text by eye, then
 * writes an extractor from a skeleton of the DOM; the code runs in the
 * sandbox and is kept only when its rows pass the check and include the
 * rows the eye saw. A failed check goes back with the reason, a few rounds.
 * The same call re-writes a kept op whose page changed (walks heal with it).
 */
import { z } from "zod";
import type { FlowPage } from "../browser/flow.js";
import {
  checkRows,
  dedupe,
  inSandbox,
  type RecordsOp,
  type Row,
  runExtractor,
  snapshot,
} from "../browser/records.js";
import { completeJson, type Llm, type LlmUsage } from "../llm/types.js";

export interface WriteRecords {
  fp: FlowPage;
  llm: Llm;
  goal: string;
  as: string;
  fields: RecordsOp["fields"];
  /** The field unique per row. */
  key: string;
  max?: number | undefined;
  /** Write, run, check rounds. */
  rounds?: number;
}

export type Written =
  | { op: RecordsOp; rows: Row[]; html: string; usage: LlmUsage }
  | { error: string; usage: LlmUsage };

const ROUNDS = 3;
/** Rows the eye copies: first, middle and last it can see. */
const SAMPLE = 3;
/** Of the eye's rows, the code must find at least this share. */
const FOUND = 2 / 3;
const SKELETON_CHARS = 60_000;

const EYE = `You read a web page's text and copy out rows a person sees as a list of records.
Copy values exactly as the page writes them; never invent. null when a row lacks a field.
Reply with one JSON object: {"rows":[{...}]}, at most ${SAMPLE} rows, from different parts of the list (first, middle, last you can see).
If the page shows no such rows, reply {"rows":[]}.`;

const WRITE = `You write a JavaScript function body that reads rows off a web page's DOM.
It runs as: function (root) { <your code> }, where root is the document.
Return an array of plain objects, one per row, with exactly the keys asked for. A value is a trimmed string, or null when the row has none.
Use DOM reads only (querySelectorAll, closest, textContent, innerText, getAttribute, href). No network, timers, async or navigation: they are blocked.
Pick what holds for every row: ids, data-* and aria attributes, roles, structure and text anchors over class names that look generated.
Return every row on the page, not just the sample.
Reply with one JSON object: {"code":"..."}.`;

/** The DOM as short lines: tag, id, classes, the attributes a selector uses, own text; look-alike siblings folded. */
const SKELETON = `(() => {
  const SKIP = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE","SVG","PATH","LINK","META","HEAD"]);
  const ATTRS = ["role","aria-label","href","datetime","title","alt","name","type"];
  const cut = (s, n) => s.length > n ? s.slice(0, n) + "…" : s;
  const own = (el) => cut([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).filter(Boolean).join(" "), 80);
  const sig = (el) => el.tagName + "." + [...el.classList].slice(0, 3).join(".");
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + cut(el.id, 40);
    for (const c of [...el.classList].slice(0, 4)) s += "." + cut(c, 30);
    for (const a of el.attributes) {
      if (ATTRS.includes(a.name) || a.name.startsWith("data-")) s += " [" + a.name + "=" + JSON.stringify(cut(a.value, 80)) + "]";
    }
    const t = own(el);
    return t ? s + " " + JSON.stringify(t) : s;
  };
  const bare = (el) => !el.id && !el.classList.length && !own(el) && el.children.length === 1 &&
    ![...el.attributes].some((a) => ATTRS.includes(a.name) || a.name.startsWith("data-"));
  const out = [];
  let left = ${SKELETON_CHARS};
  const walk = (el, d) => {
    if (left <= 0 || SKIP.has(el.tagName)) return;
    if (bare(el)) return walk(el.children[0], d);
    const line = "  ".repeat(Math.min(d, 24)) + describe(el);
    out.push(line);
    left -= line.length + 1;
    const kids = [...el.children];
    for (let i = 0; i < kids.length; ) {
      let j = i;
      while (j < kids.length && sig(kids[j]) === sig(kids[i])) j++;
      for (let k = i; k < Math.min(j, i + 2); k++) walk(kids[k], d + 1);
      if (j - i > 2) out.push("  ".repeat(Math.min(d + 1, 24)) + "(+" + (j - i - 2) + " more like these)");
      i = j;
    }
  };
  walk(document.body, 0);
  return out.join("\\n");
})()`;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The eye's rows the code did not find: each filled value appears in one row, either way round. */
export function missedSample(rows: Row[], sample: Row[]): Row[] {
  const hit = (row: Row, s: Row) =>
    Object.entries(s).every(([k, v]) => {
      if (!v) return true;
      const got = row[k];
      if (!got) return false;
      const [a, b] = [norm(got), norm(v)];
      return a.includes(b) || b.includes(a);
    });
  return sample.filter((s) => !rows.some((r) => hit(r, s)));
}

const fieldLines = (o: Pick<WriteRecords, "fields" | "key">) =>
  o.fields
    .map(
      (f) =>
        `- ${f.key}: ${f.says}${f.optional ? " (often empty)" : ""}${f.key === o.key ? " (unique per row)" : ""}`,
    )
    .join("\n");

export async function writeRecords(o: WriteRecords): Promise<Written> {
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  const add = (u: LlmUsage) => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
  };
  const keys = o.fields.map((f) => f.key);
  const html = await snapshot(o.fp.page);

  const eye = await completeJson(
    o.llm,
    z.object({ rows: z.array(z.record(z.string(), z.unknown())).max(10) }),
    {
      system: EYE,
      prompt: `Rows of: ${o.goal}\nFields:\n${fieldLines(o)}\n\nPage ${o.fp.url()}:\n${await o.fp.text()}`,
      maxTokens: 1_200,
      purpose: "records-eye",
    },
  );
  add(eye.usage);
  const sample: Row[] = eye.value.rows.slice(0, SAMPLE).map((r) =>
    Object.fromEntries(
      keys.map((k) => {
        const v = r[k];
        return [k, typeof v === "string" && v.trim() ? v.trim() : null];
      }),
    ),
  );
  if (!sample.length) return { error: "the page shows no rows of these fields", usage };

  const skeleton = await inSandbox<string>(html, SKELETON);
  let last: { code: string; problem: string } | null = null;
  for (let round = 0; round < (o.rounds ?? ROUNDS); round++) {
    const wrote = await completeJson<{ code: string }>(
      o.llm,
      z.object({ code: z.string().min(10) }),
      {
        system: WRITE,
        prompt: [
          `Rows of: ${o.goal}`,
          `Keys:\n${fieldLines(o)}`,
          `Rows a person sees on the page:\n${JSON.stringify(sample, null, 1)}`,
          `The DOM (${o.fp.url()}):\n${skeleton}`,
          ...(last ? [`Your last code:\n${last.code}\nIt failed: ${last.problem}. Fix it.`] : []),
        ].join("\n\n"),
        maxTokens: 2_500,
        purpose: "records-write",
      },
    );
    add(wrote.usage);
    const code: string = wrote.value.code;
    let problem: string | null;
    let rows: Row[] = [];
    try {
      rows = dedupe(await runExtractor(html, { code, fields: o.fields }), o);
      const missed = missedSample(rows, sample);
      problem =
        checkRows(rows, { fields: o.fields, min: 1 }) ??
        (missed.length > sample.length * (1 - FOUND)
          ? `${rows.length} rows, but not these, which the page shows: ${JSON.stringify(missed)}`
          : null);
    } catch (err) {
      problem = `it threw: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    }
    if (!problem) {
      const op: RecordsOp = {
        kind: "records",
        goal: o.goal,
        as: o.as,
        fields: o.fields,
        key: o.key,
        code,
        min: Math.max(1, Math.floor(rows.length / 2)),
        ...(o.max ? { max: o.max } : {}),
        sample,
      };
      return { op, rows, html, usage };
    }
    last = { code, problem };
  }
  return { error: `no code passed the check: ${last?.problem ?? "none written"}`, usage };
}
