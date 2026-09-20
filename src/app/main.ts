/** Restate endpoint (:9081) and the UI + API (:9080) in one process, sharing the event bus. */

import { join } from "node:path";
import { serve } from "@restatedev/restate-sdk/node";
import pino from "pino";
import { agentSessions } from "../agent/sessions.js";
import type { FailureRecord } from "../browser/session.js";
import { httpClient } from "../clients/http.js";
import { compile, saveOutline, writeRendered } from "../compiler/index.js";
import { startExplore } from "../explore/server.js";
import { expandHome } from "../google-auth.js";
import type { Recording } from "../recorder/types.js";
import { startUiServer } from "../ui/server.js";
import { ingress } from "./client.js";
import { loadEnvFile, loadSettings } from "./config.js";
import { cloudAdminUrl, planEndpoint } from "./endpoint.js";
import { registerDeployment } from "./register.js";
import { initSentry } from "./sentry.js";
import {
  approverFor,
  browserOptions,
  budgetOf,
  buildApp,
  COMPILED_DIR,
  COMPILED_LIB,
  gmailFor,
  linqFor,
  llmFor,
  loginFor,
  paceFor,
} from "./services.js";
import { statusOf } from "./status.js";

const root = loadEnvFile();
const settings = loadSettings();
const log = pino({ level: settings.logLevel });
const sentry = settings.sentryDsn
  ? initSentry({ dsn: settings.sentryDsn, environment: settings.sentryEnvironment })
  : null;
const app = await buildApp(settings, log);
if (sentry) {
  app.bus.subscribe((_seq, e) => void sentry.event(e));
  log.info({ environment: settings.sentryEnvironment }, "sentry on");
}
const plan = planEndpoint(settings);
let register: { adminUrl: string; endpointUrl: string } | null = null;
if (plan.mode === "listen") {
  await serve({ services: app.services, port: plan.port, identityKeys: plan.identityKeys });
  log.info({ port: plan.port, browser: settings.browser }, "autobrowse restate endpoint");
  if (plan.register && settings.restateAdminUrl) {
    register = { adminUrl: settings.restateAdminUrl, endpointUrl: plan.register };
  }
} else {
  // No inbound port: the worker dials Restate Cloud and registers the tunnel URL it is handed.
  const { connectTunnel } = await import("@restatedev/restate-sdk-tunnel");
  const tunnel = connectTunnel({
    services: app.services,
    tunnelName: plan.tunnelName,
    environmentId: plan.environmentId,
    region: plan.region,
    signingPublicKey: plan.signingPublicKey,
    authToken: settings.restateAuthToken as string,
  });
  await tunnel.ready;
  if (!tunnel.deploymentUrl) throw new Error("restate tunnel handshake gave no deployment URL");
  log.info({ tunnel: plan.tunnelName, browser: settings.browser }, "autobrowse restate tunnel up");
  register = {
    adminUrl: settings.restateAdminUrl ?? cloudAdminUrl(plan.environmentId, plan.region),
    endpointUrl: tunnel.deploymentUrl,
  };
}
if (register) {
  const reg = await registerDeployment({
    ...register,
    http: httpClient(),
    authToken: settings.restateAuthToken ?? null,
  });
  log.info({ deployment: reg.id, services: reg.services }, "registered with restate");
}

// The person hears once a day when the model budget is spent; `app` exists by the time any call is made.
const llm = llmFor(settings, undefined, (err) => {
  log.warn({ used: err.used, cap: err.cap }, "model budget spent");
  void app.channel.note?.(`autobrowse: ${err.message}`).catch(() => undefined);
});
const approver = approverFor(settings, gmailFor(settings));
if (!approver) log.warn("no channel a person can answer on: payment steps will be refused");
const agent = llm
  ? agentSessions({
      llm,
      dir: join(expandHome(settings.recordingsDir), ".sessions"),
      ...(app.channel.note ? { notify: app.channel.note.bind(app.channel) } : {}),
      open: (site, port) =>
        startExplore({
          site,
          browser: browserOptions(settings, false),
          recordingsDir: expandHome(settings.recordingsDir),
          port,
          login: loginFor(settings, gmailFor(settings)),
          pace: paceFor(settings), // an agent browses at a person's pace: sites watch for the other kind
          sink: app.sink,
          ...(approver ? { approve: approver } : {}),
        }),
    })
  : undefined;
if (settings.autoHeal && agent) {
  const { healFailure, healLine } = await import("../agent/heal.js");
  const { proofLine } = await import("../workflows/proof.js");
  const healing = new Set<string>();
  app.onFailure = (record, file) => {
    // Only a plain failure heals; a person's step stays theirs, an interrupted leg retries itself.
    if (record.kind !== "failed") return;
    const key = `${record.site}/${record.flow}`;
    if (healing.has(key)) return;
    healing.add(key);
    void healFailure(record, {
      agent,
      compiledDir: COMPILED_DIR,
      recordingsDir: expandHome(settings.recordingsDir),
      lib: COMPILED_LIB,
      prove: async (name) => proofLine(await proveCompiled(name)),
    })
      .then((out) => {
        log.info({ heal: out, file }, "heal");
        return app.channel.note?.(healLine(out));
      })
      .catch((err: Error) => log.warn({ err: err.message, file }, "heal failed"))
      .finally(() => healing.delete(key));
  };
  log.info("auto-heal on");
} else if (settings.autoHeal) {
  log.warn("AUTO_HEAL set without a model: nothing heals");
}
const linq = linqFor(settings);
const status = statusOf(settings, {
  llm: llm?.id ?? null,
  budget: budgetOf(llm),
  memory: app.memory.id,
  workflows: (await app.workflows()).map((w) => w.name),
});
log.info(status, "autobrowse setup");
startUiServer({
  status,
  ...(agent ? { agent } : {}),
  ...(llm ? { llm } : {}),
  ...(linq
    ? {
        linq: {
          ...linq,
          ...(settings.linqWebhookSecret ? { secret: settings.linqWebhookSecret } : {}),
        },
      }
    : {}),
  port: settings.uiPort,
  ...(settings.uiHost ? { host: settings.uiHost } : {}),
  distDir: `${root}/ui/dist`,
  workflows: app.workflows,
  proofs: app.proofs,
  prove: proveCompiled,
  ...(agent
    ? {
        heal: async (record: FailureRecord) => {
          const { healFailure } = await import("../agent/heal.js");
          const { proofLine } = await import("../workflows/proof.js");
          return healFailure(record, {
            agent,
            compiledDir: COMPILED_DIR,
            recordingsDir: expandHome(settings.recordingsDir),
            lib: COMPILED_LIB,
            prove: async (name) => proofLine(await proveCompiled(name)),
          });
        },
      }
    : {}),
  budget: () => budgetOf(llm),
  ingress: ingress({
    url: settings.restateIngressUrl,
    authToken: settings.restateAuthToken ?? null,
  }),
  bus: app.bus,
  recordingsDir: expandHome(settings.recordingsDir),
  artifactsDir: expandHome(settings.artifactsDir),
  compile: compileRecording,
  token: settings.uiToken,
});
async function compileRecording(rec: Recording) {
  const out = await compile(rec, { llm, lib: COMPILED_LIB });
  // Written where the Compiled object loads from: it is on the Runs page at once.
  // The outline beside it is the editable source; healing rewrites one step of it.
  const dir = join(COMPILED_DIR, out.outline.name);
  await writeRendered(dir, out);
  await saveOutline(dir, out.outline);
  return out;
}
/** One proof run of a compiled flow, kept beside it; the catalog reads it back on the next listing. */
async function proveCompiled(workflow: string) {
  const { proveWorkflow, writeProof } = await import("../workflows/proof.js");
  const found = await app.catalog.get(workflow);
  if (!found) throw new Error(`compiled workflow ${workflow} did not load`);
  const proof = await proveWorkflow(found.workflow, app.browser);
  await writeProof(found.dir, proof);
  return proof;
}
if (llm && settings.evaluateEveryHours > 0 && app.channel.note) {
  const { proposeWorkflows, readFailures } = await import("../agent/evaluator.js");
  const { scheduleEvaluator } = await import("../agent/schedule.js");
  const { listRecordings, loadRecording } = await import("../recorder/store.js");
  const recordingsDir = expandHome(settings.recordingsDir);
  const note = app.channel.note.bind(app.channel);
  const builder =
    settings.autoBuild && agent
      ? {
          agent,
          notify: note,
          remember: new Set<string>(),
          compile: async (name: string) => ({
            workflow: (await compileRecording(await loadRecording(recordingsDir, name))).outline
              .name,
          }),
          prove: async (workflow: string) => {
            const { proofLine } = await import("../workflows/proof.js");
            return proofLine(await proveCompiled(workflow));
          },
        }
      : null;
  if (settings.autoBuild && !builder) log.warn("AUTO_BUILD set without a model: nothing builds");
  scheduleEvaluator({
    everyHours: settings.evaluateEveryHours,
    evidence: async () => ({
      failures: await readFailures(expandHome(settings.artifactsDir)),
      sessions: agent?.list() ?? [],
      recordings: (await listRecordings(recordingsDir)).map((r) => ({
        name: r.name,
        site: r.site,
      })),
      workflows: (await app.workflows()).map((w) => ({ name: w.name, description: w.description })),
    }),
    propose: (e) => proposeWorkflows(llm, e),
    notify: note,
    ...(builder
      ? {
          build: async (proposals) => {
            const { buildProposals } = await import("../agent/builder.js");
            return buildProposals(proposals, builder);
          },
        }
      : {}),
    onError: (err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "evaluator");
      sentry?.error(err, { where: "evaluator" });
    },
  });
  log.info(
    { everyHours: settings.evaluateEveryHours, autoBuild: builder !== null },
    "evaluator scheduled",
  );
}
log.info(
  {
    port: settings.uiPort,
    auth: Boolean(settings.uiToken),
    llm: llm?.id ?? "none",
    memory: app.memory.id,
  },
  "autobrowse ui",
);
