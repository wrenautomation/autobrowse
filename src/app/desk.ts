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
 * It also serves `claude`: questions to Claude Code on this Mac, read only (`src/claude/`),
 * and for Wren `studio`: renders the Videos page asks for, and new recordings picked up every
 * minute (`src/studio/`); and `calls`: William's calls recorded by OBS (`src/calls/`).
 * launchd keeps it (and the tunnel) up: `deploy/desk/`.
 */
import http2 from "node:http2";
import { resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import pino from "pino";
import { obsBooth } from "../calls/obs.js";
import { Recorder } from "../calls/recorder.js";
import { callsService, macBanner, watchCalls } from "../calls/service.js";
import { OBS_CREDENTIAL } from "../calls/setup.js";
import { awsCliLoginChore } from "../chores/aws-login.js";
import { CLAUDE_SERVICE, claudeService } from "../claude/service.js";
import { httpClient } from "../clients/http.js";
import { isDefaultOwner, named } from "../owner.js";
import { fileSiteCalls } from "../runs/calls.js";
import { DESK_SERVICE, sitesService } from "../sites/index.js";
import { studioService, watchRecordings, wrenCheckout, wrenIn } from "../studio/service.js";
import { registerOnBox } from "./box-register.js";
import { cloudAdminUrl, planEndpoint } from "./endpoint.js";
import { awsFor, boot } from "./owner.js";
import { registerDeployment } from "./register.js";
import { buildApp, credentialsFor, siteCallsDirFor, watchersFor } from "./services.js";

/** The port deploy/desk/install.sh points the Cloudflare Tunnel at. */
const DESK_PORT = 9083;

const { settings } = boot();
const log = pino({ level: settings.logLevel });
const app = await buildApp(settings, log);
const watchers = watchersFor(settings, app.browser, log);
const desk = sitesService(
  app.sites,
  named(DESK_SERVICE, settings.owner),
  fileSiteCalls(siteCallsDirFor(settings)),
  watchers,
  // A busy profile: who waited, and which idle explore a write took it from.
  { wait: { log: (msg, extra) => log.info(extra ?? {}, msg) } },
);
// Claude Code reads the workspace holding this checkout (wren's `Ask`).
const claude = claudeService(resolve(".."), named(CLAUDE_SERVICE, settings.owner));
// Wren's video editor: its prod, its recordings; never another owner's desk.
const wren = isDefaultOwner(settings.owner) ? wrenIn(wrenCheckout(resolve(".."))) : null;
// William's calls, recorded by OBS on this Mac (wren designs/2026-10-16-call-recording.md).
const recorder = wren
  ? new Recorder({
      booth: obsBooth(async () => {
        const cred = await credentialsFor(settings).get(OBS_CREDENTIAL);
        if (!cred?.password) throw new Error("no OBS password: autobrowse calls setup");
        return cred.password;
      }),
      wren,
      log: (msg) => log.info({ calls: msg }, "calls"),
      notify: macBanner,
    })
  : null;
const services =
  wren && recorder ? [desk, claude, studioService(wren), callsService(recorder)] : [desk, claude];
await new Promise<void>((ok) =>
  http2
    .createServer(
      createEndpointHandler({
        services,
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
    services,
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
  reg = await registerOnBox(awsFor(settings)).catch(async (err: unknown) => {
    // The console session lapses every ~12 h; a restart past that crash-looped the desk for two
    // hours (2026-10-14). William's own desk renews it from the aws profile and tries once more.
    if ((err as Error).name !== "CredentialsProviderError" || !isDefaultOwner(settings.owner))
      throw err;
    log.warn("aws session expired: renewing it");
    const r = await awsCliLoginChore(app.browser, { user: "william" });
    if (!r.ok) throw new Error(`aws-login failed: ${r.detail}`);
    return registerOnBox(awsFor(settings));
  });
}
if (wren) watchRecordings(wren, (msg) => log.info({ watch: msg }, "recordings"));
if (recorder) watchCalls(recorder, (msg) => log.warn({ calls: msg }, "calls"));
watchers?.start();
// A stalled event loop starves every Restate stream on it: calls arrive past their 60 s token
// and connections die (2026-10-16). Log any stall over 2 s, so the next one is proven.
const loopDelay = monitorEventLoopDelay({ resolution: 50 });
loopDelay.enable();
setInterval(() => {
  const maxMs = Math.round(loopDelay.max / 1e6);
  if (maxMs > 2_000) log.warn({ maxMs }, "desk event loop stalled");
  loopDelay.reset();
}, 10_000).unref();
// deploy/desk/update.mjs waits for this exact message after a restart.
log.info(
  { deployment: reg.id, services: reg.services, browser: settings.browser, on: plan.mode },
  "desk up",
);
