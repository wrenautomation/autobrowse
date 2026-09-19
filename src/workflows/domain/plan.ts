/** What one domain provision is asked to produce. Validated once, stored on the run as given. */
import { z } from "zod";

const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/;
const LOCAL = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const inboxSchema = z.object({
  /** The part before @. */
  local: z.string().regex(LOCAL),
  givenName: z.string().min(1),
  familyName: z.string().min(1),
});

export const planSchema = z.object({
  domain: z.string().regex(DOMAIN),
  inboxes: z.array(inboxSchema).min(1),
  /** wren niches the inboxes may serve. */
  niches: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]).default("all"),
  /** Signature HTML for Gmail send-as; wren carries its own in the roster. */
  signatureHtml: z.string().default(""),
  /** Buy the domain when nobody holds it (approval gate first). */
  buy: z.boolean().default(true),
  /** Enrol the inboxes in warmup (browser + human consent). */
  warmup: z.boolean().default(true),
  /** Hand the inboxes to wren: roster + loops. */
  handoff: z.boolean().default(true),
  /** Plan every step, do nothing irreversible; stops before the first one. */
  dryRun: z.boolean().default(false),
});

export type Inbox = z.infer<typeof inboxSchema>;
export type Plan = z.infer<typeof planSchema>;
export type PlanInput = z.input<typeof planSchema>;

export const parsePlan = (input: unknown): Plan => planSchema.parse(input);

export const inboxAddress = (plan: Pick<Plan, "domain">, inbox: Pick<Inbox, "local">): string =>
  `${inbox.local}@${plan.domain}`.toLowerCase();

/** `local:Given:Family` from the command line. */
export function parseInboxSpec(spec: string): Inbox {
  const parts = spec.split(":");
  if (parts.length !== 3 || parts.some((p) => p === ""))
    throw new Error(`inbox must be local:Given:Family, got "${spec}"`);
  const [local, givenName, familyName] = parts as [string, string, string];
  return inboxSchema.parse({ local, givenName, familyName });
}
