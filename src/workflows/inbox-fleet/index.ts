/**
 * Cold-email inboxes on new domains, end to end: domains bought at
 * Dynadot, mailboxes ordered from Inbox Insiders (full control, uploaded
 * to Instantly), each domain moved to its own Route 53 name servers, its
 * site masked onto the main one by CloudFront (no redirect), checked from
 * public DNS, then warming on the fleet preset. Two gates spend: `buy`
 * and `order`. See designs/2026-10-03-inbox-fleet.md.
 */
import type { CredentialStore } from "credvault";
import { z } from "zod";
import type { AwsDomainClient } from "../../clients/aws-domain.js";
import type { DynadotClient } from "../../clients/dynadot.js";
import type { InboxInsidersClient } from "../../clients/inbox-insiders.js";
import type { InstantlyClient } from "../../clients/instantly.js";
import { defineWorkflow } from "../../engine/workflow.js";
import { DOMAIN } from "../domain/plan.js";
import { MAIN_SITE } from "../redirect/index.js";
import * as s from "./steps.js";

export const planSchema = z.object({
  domains: z
    .array(
      z.object({
        name: z.string().regex(DOMAIN).describe("e.g. wrenautomati0n.com"),
        mailboxes: z
          .enum(["google_workspace", "private_smtp"])
          .describe("Three of this kind on the domain"),
      }),
    )
    .min(1),
  sender: z
    .string()
    .regex(/^\S+(\s+\S+)+$/, "first and last name")
    .describe("The name on every mailbox, first and last"),
  site: z
    .string()
    .url()
    .default(MAIN_SITE)
    .describe("What each domain's web address shows (masked)"),
  brand: z.string().optional().describe("Brand name Inbox Insiders writes into the mailboxes"),
  dryRun: z.boolean().default(false),
});

export type Plan = z.infer<typeof planSchema>;

/** What the fleet needs from the world. Built once in `app/services.ts`; faked in tests. */
export interface FleetDeps {
  /** Each null while its key is not in the env store. */
  dynadot: () => Promise<DynadotClient | null>;
  inboxInsiders: () => Promise<InboxInsidersClient | null>;
  instantly: () => Promise<InstantlyClient | null>;
  /** The raw keys Inbox Insiders takes inside an order: it writes DNS at Dynadot and uploads to Instantly. */
  orderKeys: () => Promise<{ dynadot: string; instantly: string }>;
  aws: AwsDomainClient;
  credentials: CredentialStore;
  /** Public DNS and the web, as a stranger sees them. */
  probe: s.Probe;
}

export const inboxFleetWorkflow = defineWorkflow<FleetDeps, s.FleetMemo>()({
  name: "inbox-fleet",
  description:
    "Buy domains, order mailboxes, isolate DNS on Route 53, mask the site, warm in Instantly",
  plan: planSchema,
  steps: [s.check, s.buy, s.order, s.ready, s.isolate, s.mask, s.verify, s.warmup, s.credentials],
  emptyMemo: () => ({}),
});

export type InboxFleetWorkflow = typeof inboxFleetWorkflow;
export { WARMUP } from "./steps.js";
