/** Restate endpoint on Node (:9081) and the UI (:9080) in one process. */
import { serve } from "@restatedev/restate-sdk/node";
import pino from "pino";
import { loadEnvFile, loadSettings } from "./config.js";
import { buildApp } from "./services.js";

loadEnvFile();
const settings = loadSettings();
const log = pino({ level: settings.logLevel });
const app = buildApp(settings, log);
await serve({ services: app.services, port: settings.restatePort });
log.info({ port: settings.restatePort, browser: settings.browser }, "autobrowse restate endpoint");
