/**
 * `autobrowse connectors …`: wren's connector apps (HubSpot, QuickBooks,
 * Jobber). `keys` reads an app's client id and secret off its console into
 * the store; `prod` merges them into wren's second env parameter as
 * `WREN_CONNECTOR_*`; `hubspot-upload` redeploys the HubSpot project from
 * `assets/connectors/hubspot`. Nothing prints a value.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Command } from "commander";
import type { EnvStore } from "credvault";
import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import {
  CONNECTOR_KEYS,
  type ConnectorApp,
  hubspotConnectorKeys,
  jobberConnectorKeys,
  quickbooksConnectorKeys,
} from "../browser/flows/connector-keys.js";
import { awsConfigFromEnv } from "../owner.js";
import { CONNECTOR_PROFILES, CONNECTOR_URLS } from "../sites/connectors.js";

const CONNECTOR_FLOWS: Record<ConnectorApp, BrowserFlow<never, unknown>> = {
  hubspot: hubspotConnectorKeys as BrowserFlow<never, unknown>,
  quickbooks: quickbooksConnectorKeys as BrowserFlow<never, unknown>,
  "quickbooks-dev": quickbooksConnectorKeys as BrowserFlow<never, unknown>,
  jobber: jobberConnectorKeys as BrowserFlow<never, unknown>,
};

import type { SiteFacade } from "../sites/facade.js";

/** Read by wren's Lambda and box through `WREN_SSM_ENV_PARAM`; `/wren/prod/env` is near its cap. */
export const WREN_ENV_PARAM = "/wren/prod/env-2";
/** Standard tier: past it the parameter would need Advanced, which bills. */
const STANDARD_CAP = 4096;
const HUBSPOT_ACCOUNT = "343773398";

const appOf = (s: string): ConnectorApp => {
  if (!(s in CONNECTOR_KEYS))
    throw new Error(`no connector app ${s}; one of ${Object.keys(CONNECTOR_KEYS).join(", ")}`);
  return s as ConnectorApp;
};

/** Merge `names` (store values) into the JSON parameter as `WREN_<name>`; other names untouched. */
export async function mergeIntoWrenEnv(
  store: EnvStore,
  names: readonly string[],
  ssm = new SSMClient(awsConfigFromEnv()),
): Promise<{ added: string[]; changed: string[]; size: number }> {
  const got = await store.getMany([...names]);
  const missing = names.filter((n) => !got[n]);
  if (missing.length) throw new Error(`not in the store: ${missing.join(", ")}`);
  const r = await ssm.send(new GetParameterCommand({ Name: WREN_ENV_PARAM, WithDecryption: true }));
  const cur = JSON.parse(r.Parameter?.Value ?? "{}") as Record<string, string>;
  const next = { ...cur };
  for (const n of names) next[`WREN_${n}`] = got[n] as string;
  const body = JSON.stringify(next);
  if (body.length > STANDARD_CAP)
    throw new Error(`${WREN_ENV_PARAM} would be ${body.length} chars, over ${STANDARD_CAP}`);
  const changed = names.map((n) => `WREN_${n}`).filter((k) => k in cur && cur[k] !== next[k]);
  const added = Object.keys(next).filter((k) => !(k in cur));
  if (added.length || changed.length)
    await ssm.send(
      new PutParameterCommand({
        Name: WREN_ENV_PARAM,
        Value: body,
        Type: "SecureString",
        Overwrite: true,
      }),
    );
  return { added, changed, size: body.length };
}

export function registerConnectorsCommands(
  program: Command,
  deps: {
    store: () => EnvStore;
    sites: () => SiteFacade | undefined;
    runner: () => FlowRunner;
  },
): void {
  const c = program
    .command("connectors")
    .description(
      "wren's connector apps (HubSpot, QuickBooks, Jobber): keys, prod env, HubSpot deploy",
    );
  c.command("keys <app>")
    .description(
      `Read one app's client id and secret off its developer console into the store (${Object.keys(CONNECTOR_KEYS).join(", ")})`,
    )
    .option("--check", "compare with the store instead: say which match, keep nothing")
    .action(async (name: string, o: { check?: boolean }) => {
      const app = appOf(name);
      if (o.check) {
        const runner = deps.runner();
        const flow = CONNECTOR_FLOWS[app];
        const seen = new Map<string, string>();
        await runner.run(
          { ...flow, site: CONNECTOR_PROFILES[app] },
          {
            url: CONNECTOR_URLS[app],
            ...(app === "quickbooks-dev" ? { dev: true } : {}),
            sink: { put: async (n: string, v: string) => void seen.set(n, v) },
          },
        );
        const stored = await deps.store().getMany([...CONNECTOR_KEYS[app]]);
        for (const n of CONNECTOR_KEYS[app])
          console.log(`${n}: ${stored[n] === seen.get(n) ? "matches" : "DIFFERS"}`);
        return;
      }
      const sites = deps.sites();
      if (!sites) throw new Error("no site apis here");
      const { made } = await sites.setup(
        "connectors",
        `${app}-keys`,
        null,
        CONNECTOR_PROFILES[app],
      );
      // The site sink keeps them in the shared store too.
      console.log(`kept ${made.join(", ")}`);
    });
  c.command("prod [apps...]")
    .description(
      `Merge the apps' keys (every app but quickbooks-dev by default) into ${WREN_ENV_PARAM} as WREN_CONNECTOR_*; wren reads them on its next cold start`,
    )
    .action(async (apps: string[]) => {
      const chosen = apps.length
        ? apps.map(appOf)
        : (Object.keys(CONNECTOR_KEYS) as ConnectorApp[]).filter((a) => a !== "quickbooks-dev");
      const r = await mergeIntoWrenEnv(
        deps.store(),
        chosen.flatMap((a) => CONNECTOR_KEYS[a]),
      );
      console.log(
        `${WREN_ENV_PARAM}: ${r.size} chars; added ${r.added.join(", ") || "none"}; changed ${r.changed.join(", ") || "none"}`,
      );
    });
  c.command("hubspot-upload")
    .description(
      "Build and deploy the HubSpot project app (assets/connectors/hubspot) with the HubSpot CLI, as HUBSPOT_PERSONAL_ACCESS_KEY",
    )
    .action(async () => {
      const key = await deps.store().get("HUBSPOT_PERSONAL_ACCESS_KEY");
      if (!key) throw new Error("no HUBSPOT_PERSONAL_ACCESS_KEY in the store");
      const cwd = fileURLToPath(new URL("../../assets/connectors/hubspot", import.meta.url));
      const r = spawnSync(
        "npx",
        ["-y", "@hubspot/cli@8", "project", "upload", "--use-env", "--force-create"],
        {
          cwd,
          stdio: "inherit",
          env: {
            ...process.env,
            HUBSPOT_PERSONAL_ACCESS_KEY: key,
            HUBSPOT_ACCOUNT_ID: HUBSPOT_ACCOUNT,
          },
        },
      );
      if (r.status !== 0) process.exitCode = r.status ?? 1;
    });
}
