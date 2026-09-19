/** Restate endpoint (:9081) and the UI + API (:9080) in one process, sharing the event bus. */
import { serve } from "@restatedev/restate-sdk/node";
import pino from "pino";
import { compile } from "../compiler/index.js";
import { expandHome } from "../google-auth.js";
import { startUiServer } from "../ui/server.js";
import { ingress } from "./client.js";
import { loadEnvFile, loadSettings } from "./config.js";
import { buildApp, llmFor, WORKFLOWS } from "./services.js";

const root = loadEnvFile();
const settings = loadSettings();
const log = pino({ level: settings.logLevel });
const app = buildApp(settings, log);
await serve({ services: app.services, port: settings.restatePort });
log.info({ port: settings.restatePort, browser: settings.browser }, "autobrowse restate endpoint");

const llm = llmFor(settings);
startUiServer({
  port: settings.uiPort,
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
  { port: settings.uiPort, auth: Boolean(settings.uiToken), llm: llm?.id ?? "none" },
  "autobrowse ui",
);
