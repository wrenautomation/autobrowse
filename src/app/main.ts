/** Restate endpoint (:9081) and the UI + API (:9080) in one process, sharing the event bus. */
import { serve } from "@restatedev/restate-sdk/node";
import pino from "pino";
import { agentSessions } from "../agent/sessions.js";
import { httpClient } from "../clients/http.js";
import { compile } from "../compiler/index.js";
import { startExplore } from "../explore/server.js";
import { expandHome } from "../google-auth.js";
import { startUiServer } from "../ui/server.js";
import { ingress } from "./client.js";
import { loadEnvFile, loadSettings } from "./config.js";
import { registerDeployment } from "./register.js";
import { browserOptions, buildApp, gmailFor, llmFor, loginFor, WORKFLOWS } from "./services.js";

const root = loadEnvFile();
const settings = loadSettings();
const log = pino({ level: settings.logLevel });
const app = buildApp(settings, log);
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
      open: (site, port) =>
        startExplore({
          site,
          browser: browserOptions(settings, false),
          recordingsDir: expandHome(settings.recordingsDir),
          port,
          login: loginFor(settings, gmailFor(settings)),
        }),
    })
  : undefined;
startUiServer({
  ...(agent ? { agent } : {}),
  ...(llm ? { llm } : {}),
  port: settings.uiPort,
  ...(settings.uiHost ? { host: settings.uiHost } : {}),
  distDir: `${root}/ui/dist`,
  workflows: WORKFLOWS,
  ingress: ingress({
    url: settings.restateIngressUrl,
    authToken: settings.restateAuthToken ?? null,
  }),
  bus: app.bus,
  recordingsDir: expandHome(settings.recordingsDir),
  artifactsDir: expandHome(settings.artifactsDir),
  compile: (rec) => compile(rec, { llm }),
  token: settings.uiToken,
});
log.info(
  {
    port: settings.uiPort,
    auth: Boolean(settings.uiToken),
    llm: llm?.id ?? "none",
    memory: app.memory.id,
  },
  "autobrowse ui",
);
