/** Restate endpoint (:9081) and the UI + API (:9080) in one process, sharing the event bus. */

import { join } from "node:path";
import { serve } from "@restatedev/restate-sdk/node";
import pino from "pino";
import { agentSessions } from "../agent/sessions.js";
import { httpClient } from "../clients/http.js";
import { compile, writeRendered } from "../compiler/index.js";
import { startExplore } from "../explore/server.js";
import { expandHome } from "../google-auth.js";
import { startUiServer } from "../ui/server.js";
import { ingress } from "./client.js";
import { loadEnvFile, loadSettings } from "./config.js";
import { registerDeployment } from "./register.js";
import { initSentry } from "./sentry.js";
import {
  browserOptions,
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
await serve({ services: app.services, port: settings.restatePort });
log.info({ port: settings.restatePort, browser: settings.browser }, "autobrowse restate endpoint");
if (settings.restateAdminUrl && settings.restateEndpointUrl) {
  const reg = await registerDeployment({
    adminUrl: settings.restateAdminUrl,
    endpointUrl: settings.restateEndpointUrl,
    http: httpClient(),
    authToken: settings.restateAuthToken ?? null,
  });
  log.info({ deployment: reg.id, services: reg.services }, "registered with restate");
}

const llm = llmFor(settings);
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
        }),
    })
  : undefined;
const linq = linqFor(settings);
const status = statusOf(settings, {
  llm: llm?.id ?? null,
  memory: app.memory.id,
  workflows: app.workflows.map((w) => w.name),
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
  ingress: ingress({
    url: settings.restateIngressUrl,
    authToken: settings.restateAuthToken ?? null,
  }),
  bus: app.bus,
  recordingsDir: expandHome(settings.recordingsDir),
  artifactsDir: expandHome(settings.artifactsDir),
  compile: async (rec) => {
    const out = await compile(rec, { llm, lib: COMPILED_LIB });
    // Written where the worker loads from: restart, and it is on the Runs page.
    await writeRendered(join(COMPILED_DIR, out.outline.name), out);
    return out;
  },
  token: settings.uiToken,
});
if (llm && settings.evaluateEveryHours > 0 && app.channel.note) {
  const { proposeWorkflows, readFailures } = await import("../agent/evaluator.js");
  const { scheduleEvaluator } = await import("../agent/schedule.js");
  const { listRecordings } = await import("../recorder/store.js");
  const recordingsDir = expandHome(settings.recordingsDir);
  scheduleEvaluator({
    everyHours: settings.evaluateEveryHours,
    evidence: async () => ({
      failures: readFailures(expandHome(settings.artifactsDir)),
      sessions: agent?.list() ?? [],
      recordings: (await listRecordings(recordingsDir)).map((r) => ({
        name: r.name,
        site: r.site,
      })),
    }),
    propose: (e) => proposeWorkflows(llm, e),
    notify: app.channel.note.bind(app.channel),
    onError: (err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "evaluator");
      sentry?.error(err, { where: "evaluator" });
    },
  });
  log.info({ everyHours: settings.evaluateEveryHours }, "evaluator scheduled");
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
