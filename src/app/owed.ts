/**
 * The owed list and the account policy as one port for every face (CLI,
 * UI, API): what only the person can give, with each row's check, and
 * which account is for what with how ready each is. Names and addresses
 * only; never a value.
 */

import { envFileStore } from "credvault";
import type { Identity, IdentityStore } from "../auth/identities.js";
import { assignPurpose, PURPOSES } from "../auth/identities.js";
import { SITE_LOGINS } from "../auth/sites.js";
import { macDesktop } from "../desktop/mac.js";
import { phoneStatus } from "../devices/phone.js";
import { SITES } from "../sites/index.js";
import { type AccountReadiness, readiness } from "./cli-accounts.js";
import type { Settings } from "./config.js";
import {
  allNeeds,
  type DoneStore,
  KIND_TITLES,
  type NeedKind,
  type NeedsContext,
  type NeedView,
  needView,
  resolveNeeds,
} from "./needs.js";
import { credentialsFor, identitiesFor, phoneFor, sinkFor } from "./services.js";

export interface Owed {
  /** The rows and the kind titles they group under (the UI has no access to the server modules). */
  rows(): Promise<{ titles: Record<NeedKind, string>; rows: NeedView[] }>;
  /** The person says a row is done (a decision, a manual step); `note` says how. */
  done(id: string, note?: string): Promise<void>;
  undo(id: string): Promise<void>;
}

export interface PolicyView {
  purposes: Record<string, string>;
  accounts: AccountReadiness[];
}
export interface Policy {
  list(): Promise<PolicyView>;
  /** Give a purpose to a listed account, taking it from whichever had it. */
  use(purpose: string, address: string): Promise<Identity[]>;
}

export function needsContextFor(
  settings: Settings,
  env = process.env,
): () => Promise<NeedsContext> {
  return async () => ({
    sites: SITES,
    logins: SITE_LOGINS,
    identities: await identitiesFor(settings).list(),
    credentials: credentialsFor(settings, { armed: false }),
    env: (n) => env[n],
    // The sink lists both places a minted value can live; offline, the local copy alone.
    kept: once(() =>
      sinkFor(settings)
        .list()
        .catch(() => (settings.secretSink === "ssm" ? [] : envFileStore(settings.envFile).list())),
    ),
    workspaceDomain: settings.googleWorkspaceDomain?.toLowerCase() ?? null,
    // Each probe spawns a tool; several rows ask, one context answers once.
    phone: (() => {
      const phone = phoneFor(settings);
      return phone ? once(() => phoneStatus(phone.dbPath)) : null;
    })(),
    desktop: process.platform === "darwin" ? once(() => macDesktop().permissions()) : null,
    owner: settings.owner,
    envFile: settings.envFile,
  });
}

function once<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= f());
}

export function owedOf(context: () => Promise<NeedsContext>, done: DoneStore): Owed {
  return {
    rows: async () => ({
      titles: KIND_TITLES,
      rows: (await resolveNeeds(allNeeds(await context()), done.read())).map(needView),
    }),
    done: async (id, note) => done.mark(id, note),
    undo: async (id) => done.clear(id),
  };
}

export function policyOf(
  settings: Settings,
  identities: IdentityStore = identitiesFor(settings),
  env = process.env,
): Policy {
  const deps = {
    identities,
    credentials: credentialsFor(settings, { armed: false }),
    env: (n: string) => env[n],
    envNames: () => Object.keys(env),
    workspaceDomain: settings.googleWorkspaceDomain?.toLowerCase() ?? null,
    push: async () => {},
  };
  return {
    list: async () => ({
      purposes: PURPOSES,
      accounts: await Promise.all((await identities.list()).map((id) => readiness(deps, id))),
    }),
    use: async (purpose, address) => {
      const next = assignPurpose(await identities.list(), purpose, address);
      await identities.save(next);
      return next;
    },
  };
}
