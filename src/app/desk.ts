/**
 * The desk worker: the site facade on the Mac, as the Restate service `desk`.
 * Some sites refuse the box's datacenter IP (Reddit bot-checks it); their
 * browser legs run here, on a home IP, with the Mac's signed-in profiles.
 * Lean on purpose: no UI, no idle stop, no evaluator; the box stays the worker.
 * Two doors, so Restate can move without touching the Mac:
 * - Restate Cloud's tunnel, under its own name, while the Cloud settings are set.
 * - A loopback listener (DESK_PORT) that wren's self-hosted server reaches through the
 *   Cloudflare Tunnel `desk.wrenautomation.com`; it serves only calls that server signs.
 * With no Cloud settings, the desk registers itself on the box's server instead.
 * It also serves `claude`: questions to Claude Code on this Mac, read only (`src/claude/`).
 * launchd keeps it (and the tunnel) up: `deploy/desk/`.
 */
import http2 from "node:http2";
import { resolve } from "node:path";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import pino from "pino";
import { CLAUDE_SERVICE, claudeService } from "../claude/service.js";
import { httpClient } from "../clients/http.js";
import { named } from "../owner.js";
import { DESK_SERVICE, sitesService } from "../sites/index.js";
import { registerOnBox } from "./box-register.js";
import { cloudAdminUrl, planEndpoint } from "./endpoint.js";
import { awsFor, boot } from "./owner.js";
import { registerDeployment } from "./register.js";
import { buildApp } from "./services.js";

/** The port deploy/desk/install.sh points the Cloudflare Tunnel at. */
const DESK_PORT = 9083;

const { settings } = boot();
const log = pino({ level: settings.logLevel });
const app = await buildApp(settings, log);
const desk = sitesService(app.sites, named(DESK_SERVICE, settings.owner));
// Claude Code reads the workspace holding this checkout (wren's `Ask`).
const claude = claudeService(resolve(".."), named(CLAUDE_SERVICE, settings.owner));
await new Promise<void>((ok) =>
  http2
    .createServer(
      createEndpointHandler({
        services: [desk, claude],
        identityKeys: [settings.restateBoxIdentityKey],
      }),
    )
    .listen(DESK_PORT, "127.0.0.1", ok),
);
// On Cloud the settings are the box's twin: the tunnel name is overridden, never shared.
// No Cloud settings: listen, registered on the box's server.
const plan = planEndpoint({
  ...settings,
  restateTunnelName: settings.restateEnvironmentId ? DESK_SERVICE : undefined,
});
let reg: { id: string; services: string[] };
if (plan.mode === "tunnel") {
  const { connectTunnel } = await import("@restatedev/restate-sdk-tunnel");
  const tunnel = connectTunnel({
    services: [desk, claude],
    tunnelName: plan.tunnelName,
    environmentId: plan.environmentId,
    region: plan.region,
    signingPublicKey: plan.signingPublicKey,
    authToken: settings.restateAuthToken as string,
  });
  await tunnel.ready;
  if (!tunnel.deploymentUrl) throw new Error("restate tunnel handshake gave no deployment URL");
  reg = await registerDeployment({
    adminUrl: cloudAdminUrl(plan.environmentId, plan.region),
    endpointUrl: tunnel.deploymentUrl,
    http: httpClient(),
    authToken: settings.restateAuthToken ?? null,
  });
} else {
  reg = await registerOnBox(awsFor(settings));
}
// deploy/desk/update.mjs waits for this exact message after a restart.
log.info(
  { deployment: reg.id, services: reg.services, browser: settings.browser, on: plan.mode },
  "desk up",
);
