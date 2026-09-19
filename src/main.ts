/** Restate endpoint on Node: serves DomainProvision on :9081. */
import { serve } from "@restatedev/restate-sdk/node";
import pino from "pino";
import { loadEnvFile, loadSettings } from "./config.js";
import { buildServices } from "./services.js";

loadEnvFile();
const settings = loadSettings();
const log = pino({ level: settings.logLevel });
const port = Number(process.env.PORT ?? 9081);
await serve({ services: buildServices(settings, log), port });
log.info({ port, browser: settings.browser }, "provision listening");
