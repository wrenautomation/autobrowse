/**
 * One new sending domain, end to end: bought, on DNS, in Workspace, with
 * inboxes, signed, warming, on wren's roster, loops running. See
 * designs/2026-09-19-domain-flow.md.
 */
import { defineWorkflow } from "../../engine/workflow.js";
import type { DomainDeps } from "./deps.js";
import { planSchema } from "./plan.js";
import * as s from "./steps.js";

export const domainWorkflow = defineWorkflow<DomainDeps, s.DomainMemo>()({
  name: "domain",
  description: "Buy a domain, set up DNS, Workspace, inboxes, warmup; hand to wren",
  plan: planSchema,
  steps: [
    s.check,
    s.buy,
    s.zone,
    s.workspaceDomain,
    s.verifyDomain,
    s.mailDns,
    s.dkimGenerate,
    s.dkimDns,
    s.dkimStart,
    s.inboxes,
    s.signatures,
    s.authenticator,
    s.warmup,
    s.roster,
    s.loops,
  ],
  emptyMemo: () => ({}),
});

export type DomainWorkflow = typeof domainWorkflow;
export type { DomainDeps } from "./deps.js";
export { inboxAddress, type Plan, type PlanInput, parseInboxSpec, parsePlan } from "./plan.js";
export { inboxSite } from "./steps.js";
