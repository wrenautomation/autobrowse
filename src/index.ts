/**
 * Library surface: define workflows and flows, host them, drive them. The
 * layers a caller can take on their own live under subpaths (README "Use
 * as a library"): `autobrowse/sites` (site APIs, the facade, OAuth consent
 * and token minting), `autobrowse/auth` (site logins, providers, credential
 * stores), `autobrowse/do` (the one verb), `autobrowse/agent` (the page
 * outline, the exploring agent), `autobrowse/flows` (the hand-written legs).
 */

/** Compiled workflows ask for their redacted values through this. */
export { envSecrets, memorySecrets, type SecretSource } from "credkeep";
export type {
  ActOptions,
  BrowserFlow,
  FlowPage,
  FlowRunner,
  Op,
  RunnerOptions,
  Site,
} from "./browser/flow.js";
export { defineFlow, flowRunner, SITES } from "./browser/flow.js";
export { type Hints, type LocatorPlan, locate, planLocator } from "./browser/locate.js";
export { KeyedMutex } from "./browser/lock.js";
export {
  llmRepairer,
  noRepairer,
  type Repairer,
  type RepairReport,
  snapshotPage,
} from "./browser/repair.js";
export { NeedsHuman } from "./browser/session.js";
export * from "./channels/index.js";
export { httpClient } from "./clients/http.js";
export {
  type Compiled,
  type CompileOptions,
  compile,
  loadOutline,
  OUTLINE_FILE,
  type Outline,
  outlineSchema,
  polish,
  render as renderWorkflow,
  saveOutline,
  structure,
  writeRendered,
} from "./compiler/index.js";
export { fakeShell, localShell, type Shell, type ShellResult } from "./deps/shell.js";
export { envFileSink, memorySink, type SecretSink } from "./deps/sink.js";
export { macDesktop } from "./desktop/mac.js";
export {
  type Desktop,
  type DesktopNode,
  type DesktopOp,
  fakeDesktop,
  noDesktop,
  treeText,
} from "./desktop/types.js";
export type { Effects, GateAnswer, GateName } from "./engine/effects.js";
export { GateOpen, Unrecoverable } from "./engine/effects.js";
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
export * from "./llm/index.js";
export * from "./recorder/index.js";
export { domainWorkflow } from "./workflows/domain/index.js";
