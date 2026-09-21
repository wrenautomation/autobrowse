/**
 * Which ability a goal means. An exact name is a match with no model; the
 * rest is the model's read of the goal against the list: one ability and
 * its input from the goal's words and the named inputs, or none, and then
 * the site the agent should explore.
 */
import { z } from "zod";
import { completeJson, type Llm, type LlmUsage } from "../llm/index.js";
import { type Ability, fieldLine } from "./catalog.js";

export interface Pick {
  ability: Ability | null;
  /** The ability's input, mapped from the goal and the named inputs. */
  input: Record<string, unknown>;
  /** Where the agent explores when nothing matches (a site with a login, else "scratch"). */
  site: string;
  why: string;
  usage: LlmUsage;
}

const NONE: LlmUsage = { inputTokens: 0, outputTokens: 0 };

const choice = z.object({
  ability: z.string().nullable(),
  input: z.record(z.string(), z.unknown()).default({}),
  site: z.string().nullable().default(null),
  why: z.string().default(""),
});

const SYSTEM = `You route a request to one of the abilities autobrowse has, or to none.
Reply with one JSON object: {"ability": <exact name from the list or null>, "input": {<the ability's input fields, filled from the request>}, "site": <site name or null>, "why": <one line>}.
Rules:
- Pick an ability only when it does what the request asks; a near miss is null.
- "input" uses the ability's field names only; take values from the request's words and its named inputs; leave a field out when nothing gives it.
- A field marked "path" is a segment of the route: give it one of its listed values and nothing else (no query string); the other fields are separate keys.
- An ability marked "not ready" may still be picked: the agent will build it. Prefer a ready one that fits.
- "site" is where the agent should work when ability is null: one of the sites listed, or null for a site not listed.
- EARLIER PICKS show what past requests meant; a request that says the same thing in other words gets the same ability.`;

const line = (a: Ability) =>
  `- ${a.name}${a.irreversible ? " (publishes)" : ""}${a.ready ? "" : ` (not ready: ${a.missing ?? "unrecorded"})`}: ${a.summary}${a.inputs.length ? ` — inputs: ${a.inputs.map(fieldLine).join(", ")}` : ""}`;

export interface PickRequest {
  goal: string;
  inputs: Record<string, string>;
  /** The caller said where; the model is not asked about the site. */
  site?: string | null;
  /** Earlier goals and what was picked for them, newest last. */
  earlier?: readonly { goal: string; ability: string }[];
}

export async function pickAbility(
  llm: Llm | null,
  req: PickRequest,
  abilities: readonly Ability[],
  sites: readonly string[],
): Promise<Pick> {
  const exact = abilities.find((a) => a.name === req.goal.trim());
  if (exact)
    return {
      ability: exact,
      input: req.inputs,
      site: req.site ?? exact.site ?? "scratch",
      why: "named exactly",
      usage: NONE,
    };
  if (!llm)
    return { ability: null, input: {}, site: req.site ?? "scratch", why: "no model", usage: NONE };
  const named = Object.entries(req.inputs)
    .map(([k, v]) => `- ${k} = ${v}`)
    .join("\n");
  const earlier = (req.earlier ?? [])
    .slice(-20)
    .map((p) => `- "${p.goal}" → ${p.ability}`)
    .join("\n");
  const { value, usage } = await completeJson(llm, choice, {
    system: SYSTEM,
    prompt: `REQUEST: ${req.goal}\n\nNAMED INPUTS:\n${named || "(none)"}\n\nABILITIES:\n${abilities.map(line).join("\n") || "(none)"}\n\nSITES WITH A LOGIN: ${sites.join(", ") || "(none)"}${earlier ? `\n\nEARLIER PICKS:\n${earlier}` : ""}`,
    maxTokens: 600,
  });
  const ability = value.ability ? (abilities.find((a) => a.name === value.ability) ?? null) : null;
  const site =
    req.site ??
    ability?.site ??
    (value.site && sites.includes(value.site) ? value.site : "scratch");
  return { ability, input: ability ? value.input : {}, site, why: value.why, usage };
}
