/** What one domain provision is asked to produce. Validated once, stored on the run as given. */
import { z } from "zod";

export const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/;
const LOCAL = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const inboxSchema = z.object({
  local: z.string().regex(LOCAL).describe("The part before @"),
  givenName: z.string().min(1).describe("First name on the inbox"),
  familyName: z.string().min(1).describe("Last name on the inbox"),
});

export const planSchema = z.object({
  domain: z.string().regex(DOMAIN).describe("The domain, e.g. getwren.co"),
  inboxes: z
    .array(inboxSchema)
    .default([])
    .describe("Inboxes to make on it; none = buy and DNS only (a site, not a sender)"),
  niches: z
    .union([z.literal("all"), z.array(z.string().min(1)).min(1)])
    .default("all")
    .describe("wren niches the inboxes may serve"),
  signatureHtml: z
    .string()
    .default("")
    .describe("Signature HTML for Gmail send-as; wren carries its own in the roster"),
  photoUrl: z
    .string()
    .url()
    .optional()
    .describe("Each inbox's profile picture (PNG/JPEG/GIF; a GIF stays animated in Gmail)"),
  buy: z
    .boolean()
    .default(true)
    .describe("Buy the domain when nobody holds it (approval gate first)"),
  warmup: z
    .boolean()
    .default(true)
    .describe("Enrol the inboxes in Instantly warmup (API + the inbox's own consent)"),
  warmupLike: z
    .string()
    .email()
    .optional()
    .describe("An Instantly inbox whose warmup and sending settings each new inbox copies"),
  handoff: z.boolean().default(true).describe("Hand the inboxes to wren: roster + loops"),
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
