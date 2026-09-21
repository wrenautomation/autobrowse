/** The exploring agent and what it sees: the page outline, one act a step, sessions with play/pause. */
export { buildProposals, settleSession } from "./builder.js";
export {
  CODES,
  type Digest,
  type DigestOptions,
  digest,
  hintsFor,
  LEGEND,
  pageForModel,
  parseAria,
  type Ref,
} from "./digest.js";
export {
  type AgentOptions,
  type AgentResult,
  exploreWithAgent,
  type Step,
  type StepRecord,
  stepSchema,
} from "./explorer.js";
export { type HealOptions, type HealOutcome, healFailure, healLine } from "./heal.js";
export { readFailure, repairGoal, repairName } from "./repair.js";
export {
  type AgentSessions,
  agentSessions,
  type SessionStatus,
  type SessionSummary,
  type SessionsOptions,
  type SessionView,
  type StartRequest,
  summarizeSession,
} from "./sessions.js";
