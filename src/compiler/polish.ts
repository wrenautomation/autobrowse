/**
 * The model reads the outline and proposes better names, descriptions,
 * proofs and extra irreversible flags. The merge keeps everything
 * structural (ops, fields, secrets, order) and applies only what a
 * reviewer could: a rename, a description, a proof, irreversible → true.
 * It can never clear a flag or change what runs.
 */

import { z } from "zod";
import { completeJson, type Llm, type LlmUsage } from "../llm/types.js";
import type { Outline } from "./outline.js";
import { kebab } from "./structure.js";

const proposalSchema = z.object({
  description: z.string().optional(),
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

const SYSTEM = `You review an outline of a browser chore recorded by a person, about to be compiled into a durable workflow. For each step propose a short kebab-case name (a verb phrase: "search-domain", "add-to-cart"), a one-line description, and where the site has an API, how the step's result could be proven through it (proof). Mark irreversible: true for steps that spend money, create accounts or resources, or send anything. Never claim a step is reversible. Reply with JSON: {"description": "...", "steps": [{"index": 0, "name": "...", "description": "...", "proof": "..." | null, "irreversible": true|false}]}.`;

export async function polish(
  outline: Outline,
  llm: Llm,
): Promise<{ outline: Outline; usage: LlmUsage }> {
  const { value, usage } = await completeJson(llm, proposalSchema, {
    system: SYSTEM,
    prompt: JSON.stringify(outline, null, 2),
    maxTokens: 1500,
  });
  const steps = outline.steps.map((s) => ({ ...s }));
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
    outline: { ...outline, description: value.description ?? outline.description, steps },
    usage,
  };
}
