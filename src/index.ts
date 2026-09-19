/** Library surface: define workflows and flows, host them, drive them. */
export type { BrowserFlow, FlowPage, FlowRunner, Site } from "./browser/flow.js";
export { defineFlow, flowRunner, SITES } from "./browser/flow.js";
export { KeyedMutex } from "./browser/lock.js";
export { NeedsHuman } from "./browser/session.js";
export * from "./channels/index.js";
export { httpClient } from "./clients/http.js";
export type { Effects, GateAnswer, GateName } from "./engine/effects.js";
export { GateOpen } from "./engine/effects.js";
export type { RunEvent, RunRef } from "./engine/events.js";
export { memoryEffects } from "./engine/memory.js";
export { type HostDeps, makeRunObject, type RunObject } from "./engine/object.js";
export { runsRegistry } from "./engine/registry.js";
export { advance, applyAnswer, nextStep, type Outcome, runFlow, summarize } from "./engine/run.js";
export {
  defineWorkflow,
  done,
  rejected,
  type StepDef,
  type StepOf,
  skipped,
  type Workflow,
} from "./engine/workflow.js";
export * from "./recorder/index.js";
export { domainWorkflow } from "./workflows/domain/index.js";
