/** Restate endpoint (:9081) and the UI + API (:9080) in one process, sharing the event bus. */

import { serve } from "@restatedev/restate-sdk/node";
import pino from "pino";
import { httpClient } from "../clients/http.js";
import { startUiServer } from "../ui/server.js";
import { backendFor } from "./backend.js";
import { ingress } from "./client.js";
import { loadEnvFile, loadSettings } from "./config.js";
import { cloudAdminUrl, planEndpoint } from "./endpoint.js";
import { registerDeployment } from "./register.js";
import { initSentry } from "./sentry.js";
import { approverFor, budgetOf, buildApp, gmailFor, linqFor, llmFor } from "./services.js";
import { statusOf } from "./status.js";

const root = loadEnvFile();
const settings = loadSettings();
const log = pino({ level: settings.logLevel });
const bootedAt = new Date();
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
  // A tunnel is a Restate Cloud thing, so the cloud's admin URL is the right one:
  // a stale RESTATE_ADMIN_URL from a local Restate would send this registration nowhere.
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)\b/.test(settings.restateAdminUrl ?? "");
  if (local)
    log.warn(
      { adminUrl: settings.restateAdminUrl },
      "ignoring RESTATE_ADMIN_URL: this worker is on the cloud tunnel",
    );
  register = {
    adminUrl:
      !local && settings.restateAdminUrl
        ? settings.restateAdminUrl
        : cloudAdminUrl(plan.environmentId, plan.region),
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
const linq = linqFor(settings);
const status = statusOf(settings, {
  llm: llm?.id ?? null,
  budget: budgetOf(llm),
  memory: app.memory.id,
  workflows: (await app.workflows()).map((w) => w.name),
});
log.info(status, "autobrowse setup");
const backend = backendFor(settings, app, {
  llm,
  status,
  ingress: ingress({
    url: settings.restateIngressUrl,
    authToken: settings.restateAuthToken ?? null,
  }),
  ...(app.channel.note ? { notify: app.channel.note.bind(app.channel) } : {}),
});
app.doer = backend.do;
if (!approverFor(settings, gmailFor(settings))) {
  log.warn("no channel a person can answer on: payment steps will be refused");
}
if (settings.autoHeal && backend.heal) {
  const { healLine } = await import("../agent/heal.js");
  const heal = backend.heal;
  const healing = new Set<string>();
  app.onFailure = (record, file) => {
    // Only a plain failure heals; a person's step stays theirs, an interrupted leg retries itself.
    if (record.kind !== "failed") return;
    const key = `${record.site}/${record.flow}`;
    if (healing.has(key)) return;
    healing.add(key);
    void heal(record)
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
startUiServer({
  ...backend,
  touch: () => app.idle.touch(),
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
  token: settings.uiToken,
});
if (settings.idleStopMinutes > 0) {
  const { EC2Client } = await import("@aws-sdk/client-ec2");
  const { ec2Port, instanceIdFromMetadata, selfStopper } = await import("./box.js");
  const { scheduleIdleStop } = await import("./idle.js");
  const { pendingInvocations } = await import("./pending.js");
  const busyStates = new Set(["starting", "running"]);
  const services = app.services.map((s) => s.name);
  const admin = register
    ? { adminUrl: register.adminUrl, authToken: settings.restateAuthToken ?? null }
    : null;
  if (!admin)
    log.warn(
      "idle stop cannot see Restate's queue (no admin URL): a call queued while the box boots may find it stopping",
    );
  scheduleIdleStop({
    idle: app.idle,
    minutes: settings.idleStopMinutes,
    // An agent mid-goal is work; a session waiting on a person is not (it is not durable, and the person left).
    // Work Restate holds for our services is work too, even before it reaches us.
    alsoBusy: async () => {
      if ((backend.agent?.list() ?? []).some((s) => busyStates.has(s.status))) return true;
      if (!admin) return false;
      try {
        const n = await pendingInvocations({ ...admin, http: httpClient(), services });
        if (n > 0) log.info({ pending: n }, "idle, but Restate holds work for this worker");
        return n > 0;
      } catch (err) {
        // Better a box that stays up than one stopped under queued work.
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "pending check failed; staying up",
        );
        return true;
      }
    },
    stop: selfStopper({
      ec2: ec2Port(new EC2Client({ region: settings.awsRegion })),
      instanceId: async () => settings.instanceId ?? (await instanceIdFromMetadata()),
    }),
    // What this session did with secrets and money, to the person, before the lights go out.
    beforeStop: async () => {
      const { ledgerSince, ledgerSummary } = await import("../auth/ledger.js");
      const { auditFor, spendLedgerFor } = await import("./services.js");
      const lines = ledgerSummary(
        await ledgerSince(auditFor(settings), spendLedgerFor(settings), bootedAt),
      );
      if (lines.length) await app.channel.note?.(lines.join("\n"));
    },
    log,
  });
  log.info({ minutes: settings.idleStopMinutes }, "idle stop armed");
}
if (llm && settings.evaluateEveryHours > 0 && app.channel.note) {
  const { proposeWorkflows, readFailures } = await import("../agent/evaluator.js");
  const { scheduleEvaluator } = await import("../agent/schedule.js");
  const { listRecordingSummaries, loadRecording } = await import("../recorder/store.js");
  const { proofLine } = await import("../workflows/proof.js");
  const note = app.channel.note.bind(app.channel);
  const { agent, prove } = backend;
  const builder =
    settings.autoBuild && agent && prove
      ? {
          agent,
          notify: note,
          remember: new Set<string>(),
          compile: async (name: string) => ({
            workflow: (await backend.compile(await loadRecording(backend.recordingsDir, name)))
              .outline.name,
          }),
          prove: async (workflow: string) => proofLine(await prove(workflow)),
        }
      : null;
  if (settings.autoBuild && !builder) log.warn("AUTO_BUILD set without a model: nothing builds");
  scheduleEvaluator({
    everyHours: settings.evaluateEveryHours,
    evidence: async () => ({
      failures: await readFailures(backend.artifactsDir),
      sessions: agent?.list() ?? [],
      recordings: (await listRecordingSummaries(backend.recordingsDir)).map((r) => ({
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
