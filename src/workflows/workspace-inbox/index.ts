/**
 * One Google Workspace inbox on a domain already in Workspace, ready to
 * use: the user made (or kept), its password and authenticator in the
 * credential store so its profile signs itself in, signature and picture,
 * a Gmail consent token kept under its address, and its row in the
 * accounts list. Optionally on wren's roster with warmup, and given some
 * mail of its own. The steps are the domain and inbox-activity workflows'
 * own, run on a one-inbox plan. See designs/2026-10-03-workspace-inbox.md.
 */
import { z } from "zod";
import { type IdentityStore, withIdentity } from "../../auth/identities.js";
import { defineWorkflow, done, type StepDef, skipped } from "../../engine/workflow.js";
import type { DomainDeps } from "../domain/deps.js";
import {
  type Plan as DomainPlan,
  planSchema as domainPlanSchema,
  inboxSchema,
} from "../domain/plan.js";
import * as d from "../domain/steps.js";
import {
  confirm,
  type InboxActivityDeps,
  type InboxActivityMemo,
  type InboxActivityPlan,
  inboxActivityPlanSchema,
  subscribe,
} from "../inbox-activity/index.js";

export const workspaceInboxPlanSchema = z.object({
  address: z.string().trim().toLowerCase().email().describe("The inbox, e.g. will@getwren.co"),
  givenName: inboxSchema.shape.givenName,
  familyName: inboxSchema.shape.familyName,
  signatureHtml: domainPlanSchema.shape.signatureHtml,
  photoUrl: domainPlanSchema.shape.photoUrl,
  consents: z
    .array(z.string().min(1))
    .default(["gmail"])
    .describe("Sites whose OAuth consent to keep as this inbox (gmail, drive)"),
  purposes: z
    .array(z.string().min(1))
    .default(["sends"])
    .describe("Its row in the accounts list: what it is for (sends, signup, ...)"),
  niches: domainPlanSchema.shape.niches,
  warmup: z.boolean().default(false).describe("Enrol it in Instantly warmup"),
  warmupLike: domainPlanSchema.shape.warmupLike,
  handoff: z
    .boolean()
    .default(false)
    .describe("Hand it to wren: roster + loops (it starts sending)"),
  activity: z
    .boolean()
    .default(false)
    .describe("Subscribe it to free newsletters and open their confirm links"),
  dryRun: z.boolean().default(false),
});

export type WorkspaceInboxPlan = z.infer<typeof workspaceInboxPlanSchema>;

/** The consent setup of each site, as the facade runs it (`site setup <site> consent --account`). */
export interface Consents {
  /** Every token the site's consent makes is kept for `address` already. */
  held(site: string, address: string): Promise<boolean>;
  /** Consent as `address` in its own profile; the env names it kept. */
  run(site: string, address: string): Promise<readonly string[]>;
}

export type WorkspaceInboxDeps = DomainDeps &
  InboxActivityDeps & { consents: Consents; identities: IdentityStore };
export type WorkspaceInboxMemo = d.DomainMemo & InboxActivityMemo;

type Step<S extends string = string> = StepDef<
  WorkspaceInboxPlan,
  WorkspaceInboxDeps,
  WorkspaceInboxMemo,
  S
>;

/** `will@getwren.co` → the domain workflow's plan for that one inbox, buying nothing. */
export function asDomainPlan(plan: WorkspaceInboxPlan): DomainPlan {
  const [local = "", domain = ""] = plan.address.split("@");
  return domainPlanSchema.parse({
    domain,
    inboxes: [{ local, givenName: plan.givenName, familyName: plan.familyName }],
    niches: plan.niches,
    signatureHtml: plan.signatureHtml,
    ...(plan.photoUrl ? { photoUrl: plan.photoUrl } : {}),
    buy: false,
    warmup: plan.warmup,
    ...(plan.warmupLike ? { warmupLike: plan.warmupLike } : {}),
    handoff: plan.handoff,
    dryRun: plan.dryRun,
  });
}

export const asActivityPlan = (plan: WorkspaceInboxPlan): InboxActivityPlan =>
  inboxActivityPlanSchema.parse({ inbox: plan.address, dryRun: plan.dryRun });

/** Another workflow's step, run on this plan seen as theirs. */
function onPlan<P, S extends string>(
  step: StepDef<P, WorkspaceInboxDeps, WorkspaceInboxMemo, S>,
  as: (plan: WorkspaceInboxPlan) => P,
  off?: (plan: WorkspaceInboxPlan) => string | null,
): Step<S> {
  const harmless = step.harmless;
  return {
    name: step.name,
    ...(step.irreversible ? { irreversible: true } : {}),
    harmless: (plan, memo) => Boolean(off?.(plan)) || (harmless ? harmless(as(plan), memo) : false),
    run: (ctx) => {
      const why = off?.(ctx.plan);
      return why ? Promise.resolve(skipped(why)) : step.run({ ...ctx, plan: as(ctx.plan) });
    },
  };
}

const domainOf = (address: string) => address.slice(address.indexOf("@") + 1);

/** Inboxes go on a domain Workspace already serves: the domain workflow puts it there. */
const domainReady: Step<"domain-ready"> = {
  name: "domain-ready",
  async run({ fx, deps, plan }) {
    const domain = domainOf(plan.address);
    const got = await fx.run("workspace domain", () => deps.google.getDomain(domain));
    if (!got?.verified)
      throw new Error(
        `${domain} is ${got ? "unverified" : "not"} in Workspace: provision it first (autobrowse domain ${domain})`,
      );
    return done(`${domain} verified in Workspace`);
  },
};

/** A refresh token per consent site, kept as `<NAME>__<ADDRESS>`; one already kept is left. */
const consent: Step<"consent"> = {
  name: "consent",
  async run({ fx, deps, plan }) {
    if (plan.consents.length === 0) return skipped("no consents in the plan");
    const outcomes: string[] = [];
    for (const site of plan.consents) {
      const o = await fx.run(`consent ${site}`, async () => {
        if (await deps.consents.held(site, plan.address)) return "kept already";
        return `kept ${(await deps.consents.run(site, plan.address)).join(", ")}`;
      });
      outcomes.push(`${site} ${o}`);
    }
    return done(outcomes.join("; "));
  },
};

/** Its row in the accounts list, the plan's purposes added to any it had. */
const account: Step<"account"> = {
  name: "account",
  async run({ fx, deps, plan }) {
    const o = await fx.run("accounts row", async () => {
      const all = await deps.identities.list();
      const had = all.find((i) => i.address.toLowerCase() === plan.address);
      const purposes = [...new Set([...(had?.for ?? []), ...plan.purposes])];
      if (had && purposes.length === had.for.length) return "already listed";
      await deps.identities.save(
        withIdentity(all, { ...(had ?? {}), address: plan.address, at: "google", for: purposes }),
      );
      return `${had ? "now" : "listed"} for ${purposes.join(", ")}`;
    });
    return done(o);
  },
};

const noHandoff = (p: WorkspaceInboxPlan) => (p.handoff ? null : "handoff=false");
const noActivity = (p: WorkspaceInboxPlan) => (p.activity ? null : "activity=false");

export const workspaceInboxWorkflow = defineWorkflow<WorkspaceInboxDeps, WorkspaceInboxMemo>()({
  name: "workspace-inbox",
  description:
    "One Workspace inbox, ready: user, password + authenticator stored, signature, photo, Gmail consent, accounts row; optional warmup, roster, newsletters",
  plan: workspaceInboxPlanSchema,
  steps: [
    domainReady,
    onPlan(d.inboxes, asDomainPlan),
    onPlan(d.signatures, asDomainPlan),
    onPlan(d.authenticator, asDomainPlan),
    onPlan(d.photo, asDomainPlan),
    consent,
    account,
    onPlan(d.warmup, asDomainPlan),
    onPlan(d.roster, asDomainPlan, noHandoff),
    onPlan(d.loops, asDomainPlan, noHandoff),
    onPlan(subscribe, asActivityPlan, noActivity),
    onPlan(confirm, asActivityPlan, noActivity),
  ],
  emptyMemo: () => ({}),
});

export type WorkspaceInboxWorkflow = typeof workspaceInboxWorkflow;
