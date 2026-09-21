/**
 * The model reads the outline and proposes better names, descriptions,
 * proofs and extra irreversible flags. The merge keeps everything
 * structural (ops, fields, secrets, order) and applies only what a
 * reviewer could: a rename, a description, a proof, irreversible → true,
 * and a plan field's key (`field1` → `videoTitle`, carried to every op that
 * reads it). It can never clear a flag or change what runs.
 */

import { z } from "zod";
import { completeJson, type Llm, type LlmUsage } from "../llm/types.js";
import type { Outline } from "./outline.js";
import { kebab } from "./structure.js";

const proposalSchema = z.object({
  description: z.string().optional(),
  /** Plan fields by their current key, with a name that says what the value is. */
  fields: z.array(z.object({ key: z.string(), name: z.string() })).default([]),
  steps: z.array(
    z.object({
      /** Index into outline.steps, so a rename cannot be misapplied. */
      index: z.number().int().min(0),
      name: z.string().optional(),
      description: z.string().optional(),
      proof: z.string().nullable().optional(),
      irreversible: z.boolean().optional(),
    }),
  ),
});

const SYSTEM = `You review an outline of a browser chore recorded by a person, about to be compiled into a durable workflow. For each step propose a short kebab-case name (a verb phrase: "search-domain", "add-to-cart"), a one-line description, and where the site has an API, how the step's result could be proven through it (proof). Mark irreversible: true for steps that spend money, create accounts or resources, or send anything. Never claim a step is reversible. For each plan field whose key does not say what the value is (a control's label like "field1" or "textbox"), propose a camelCase name from what the value is for, read from the step that fills it and the chore's description ("videoTitle", "domain", "recipientEmail"); leave a field out when its key already says it. Reply with JSON: {"description": "...", "fields": [{"key": "<current key>", "name": "<camelCase>"}], "steps": [{"index": 0, "name": "...", "description": "...", "proof": "..." | null, "irreversible": true|false}]}.`;

const FIELD_KEY = /^[a-z][a-zA-Z0-9]*$/;

/** A plan field under a new key, in the field list and in every op that reads it. */
export function renameField(outline: Outline, from: string, to: string): Outline {
  const fields = outline.fields.map((f) => (f.key === from ? { ...f, key: to } : f));
  const value = <V extends { from: string }>(v: V): V =>
    v.from === "plan" && (v as { field?: string }).field === from ? { ...v, field: to } : v;
  const steps = outline.steps.map((s) => {
    if (s.kind === "terminal") return s;
    const url = "url" in s && s.url ? s.url.split(`{${from}}`).join(`{${to}}`) : null;
    const ops = s.ops.map((op) => {
      if (op.kind === "fill" || op.kind === "type") return { ...op, value: value(op.value) };
      if (op.kind === "upload") return { ...op, file: value(op.file) };
      return op;
    });
    return s.kind === "browser"
      ? { ...s, url, ops: ops as typeof s.ops }
      : { ...s, ops: ops as typeof s.ops };
  });
  return { ...outline, fields, steps };
}

export async function polish(
  outline: Outline,
  llm: Llm,
): Promise<{ outline: Outline; usage: LlmUsage }> {
  const { value, usage } = await completeJson(llm, proposalSchema, {
    system: SYSTEM,
    prompt: JSON.stringify(outline, null, 2),
    maxTokens: 1500,
  });
  let renamed = outline;
  const keys = new Set(outline.fields.map((f) => f.key));
  for (const f of value.fields) {
    const to = camelOf(f.name);
    if (!keys.has(f.key) || keys.has(to) || !FIELD_KEY.test(to) || to === f.key) continue;
    renamed = renameField(renamed, f.key, to);
    keys.delete(f.key);
    keys.add(to);
  }
  const steps = renamed.steps.map((s) => ({ ...s }));
  const taken = new Set(steps.map((s) => s.name));
  for (const p of value.steps) {
    const step = steps[p.index];
    if (!step) continue;
    if (p.name) {
      const name = kebab(p.name);
      if (name !== step.name && !taken.has(name)) {
        taken.delete(step.name);
        taken.add(name);
        step.name = name;
      }
    }
    if (p.description) step.description = p.description;
    if (p.proof !== undefined) step.proof = p.proof;
    if (p.irreversible === true) step.irreversible = true;
  }
  return {
    outline: { ...renamed, description: value.description ?? outline.description, steps },
    usage,
  };
}

/** `Video Title` / `video-title` / `videoTitle` → `videoTitle`. */
function camelOf(name: string): string {
  const parts = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return parts.map((w, i) => (i ? w[0]?.toUpperCase() + w.slice(1) : w)).join("");
}
