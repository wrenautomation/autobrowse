/**
 * The desk worker: the site facade on the Mac, as the Restate service `desk`.
 * Some sites refuse the box's datacenter IP (Reddit bot-checks it); their
 * browser legs run here, on a home IP, with the Mac's signed-in profiles.
 * Lean on purpose: no UI, no idle stop, no evaluator; the box stays the worker.
 * It shares the box's Restate environment under its own tunnel name, so the
 * two never take each other's calls. launchd keeps it up: `deploy/desk/`.
 */
import pino from "pino";
import { httpClient } from "../clients/http.js";
import { named } from "../owner.js";
import { DESK_SERVICE, sitesService } from "../sites/index.js";
import { cloudAdminUrl, planEndpoint } from "./endpoint.js";
import { boot } from "./owner.js";
import { registerDeployment } from "./register.js";
import { buildApp } from "./services.js";

const { settings } = boot();
const log = pino({ level: settings.logLevel });
const app = await buildApp(settings, log);
// The .env is the box's twin: the tunnel name is overridden, never shared.
const plan = planEndpoint({ ...settings, restateTunnelName: DESK_SERVICE });
if (plan.mode !== "tunnel")
  throw new Error("the desk needs the Restate Cloud tunnel settings (RESTATE_ENVIRONMENT_ID …)");
const { connectTunnel } = await import("@restatedev/restate-sdk-tunnel");
const tunnel = connectTunnel({
  services: [sitesService(app.sites, named(DESK_SERVICE, settings.owner))],
  tunnelName: plan.tunnelName,
  environmentId: plan.environmentId,
  region: plan.region,
  signingPublicKey: plan.signingPublicKey,
  authToken: settings.restateAuthToken as string,
});
await tunnel.ready;
if (!tunnel.deploymentUrl) throw new Error("restate tunnel handshake gave no deployment URL");
const reg = await registerDeployment({
  adminUrl: cloudAdminUrl(plan.environmentId, plan.region),
  endpointUrl: tunnel.deploymentUrl,
  http: httpClient(),
  authToken: settings.restateAuthToken ?? null,
});
log.info({ deployment: reg.id, services: reg.services, browser: settings.browser }, "desk up");
