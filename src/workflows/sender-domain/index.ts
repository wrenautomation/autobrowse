/**
 * The domain workflow, then the redirect one: a new sending domain whose
 * web address lands on the main site. The two still run alone.
 */
import type { z } from "zod";
import { defineWorkflow } from "../../engine/workflow.js";
import { type DomainDeps, domainWorkflow } from "../domain/index.js";
import { planSchema } from "../domain/plan.js";
import type { DomainMemo } from "../domain/steps.js";
import { redirectFields, redirectSteps } from "../redirect/index.js";

export const senderDomainPlanSchema = planSchema.extend(redirectFields);
export type SenderDomainPlan = z.infer<typeof senderDomainPlanSchema>;

export const senderDomainWorkflow = defineWorkflow<DomainDeps, DomainMemo>()({
  name: "sender-domain",
  description: "domain + redirect: provision a sending domain and 301 its site to the main one",
  plan: senderDomainPlanSchema,
  steps: [...domainWorkflow.steps, ...redirectSteps<SenderDomainPlan, DomainDeps, DomainMemo>()],
  emptyMemo: domainWorkflow.emptyMemo,
  ...(domainWorkflow.settle ? { settle: domainWorkflow.settle } : {}),
});

export type SenderDomainWorkflow = typeof senderDomainWorkflow;
