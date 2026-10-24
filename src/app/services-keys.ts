/** Secrets in SSM: one client per owner and region, the env store, API keys and their keeper, memory. */
import { dirname, join } from "node:path";
import { SSMClient } from "@aws-sdk/client-ssm";
import {
  applyProjection,
  type EnvEntry,
  type EnvStore,
  envFileStore,
  envKeys,
  type KeyStore,
  ssmEnvStore,
  syncedEnvStore,
  unsharedFile,
} from "credvault";
import { httpClient } from "../clients/http.js";
import type { KeyKeeper } from "../deps/keys.js";
import { expandHome } from "../google/auth.js";
import { backboardMemory, type Memory, memoryStore } from "../memory/index.js";
import { ownerKeys } from "../owner.js";
import { fileKeyUses } from "../reach/key-ring.js";
import { type KeysDep, ownerKeysIn, reachEnv, vaultSource } from "../reach/key-source.js";
import { type KeyAdmin, keyAdmin } from "../sites/keys.js";
import type { Settings } from "./config.js";
import { awsFor } from "./owner.js";
import { lazy } from "./services-kit.js";
import { auditFor, credentialsFor } from "./services-state.js";

export function sinkFor(
  settings: Settings,
  ssm: SSMClient = ssmFor(settings),
): EnvStore & { share?: () => Promise<string[]> } {
  const shared = envStoreFor(settings, ssm);
  return settings.secretSink === "ssm"
    ? shared
    : syncedEnvStore(envFileStore(settings.envFile), shared, {
        // A token minted while the shared store refused writes: sent by the next put or share.
        unshared: unsharedFile(join(dirname(expandHome(settings.envFile)), "unshared.json")),
      });
}

/** The store's entries `have` says this process lacks, read by name: never the whole store. */
export async function missingEntries(
  store: EnvStore,
  have: (name: string) => boolean,
): Promise<EnvEntry[]> {
  const names = (await store.list()).map((e) => e.name).filter((n) => !have(n));
  if (!names.length) return [];
  return Object.entries(await store.getMany(names)).map(([name, value]) => ({ name, value }));
}

/** One SSM client per owner and region for the process, made on first use. */
const ssmClients = new Map<string, SSMClient>();
export function ssmFor(settings: Settings): SSMClient {
  const key = `${settings.owner}|${settings.awsRegion}`;
  let c = ssmClients.get(key);
  if (!c) {
    c = lazy(() => new SSMClient(awsFor(settings)));
    ssmClients.set(key, c);
  }
  return c;
}

/**
 * The store `autobrowse env` and prod's sink share: SSM under the owner's
 * path (/autobrowse/config for the default owner). One per client and path
 * for the process: it remembers each value by version, and every value read
 * from SSM is a KMS decrypt (billed past 20k a month).
 */
const envStores = new WeakMap<SSMClient, Map<string, EnvStore>>();
export function envStoreFor(settings: Settings, ssm: SSMClient = ssmFor(settings)): EnvStore {
  const path = ownerKeys(settings.owner).ssm;
  let byPath = envStores.get(ssm);
  if (!byPath) {
    byPath = new Map();
    envStores.set(ssm, byPath);
  }
  let store = byPath.get(path);
  if (!store) {
    store = ssmEnvStore(ssm, path);
    byPath.set(path, store);
  }
  return store;
}

/**
 * The API keys (`creds key`): one row per key under the owner's SSM path
 * plus `/keys`, beside the env rows. One per client and path for the process,
 * like `envStoreFor`.
 */
const keyStores = new WeakMap<SSMClient, Map<string, KeyStore>>();
export function keyStoreFor(settings: Settings, ssm: SSMClient = ssmFor(settings)): KeyStore {
  const path = `${ownerKeys(settings.owner).ssm}/keys`;
  let byPath = keyStores.get(ssm);
  if (!byPath) {
    byPath = new Map();
    keyStores.set(ssm, byPath);
  }
  let store = byPath.get(path);
  if (!store) {
    store = envKeys(ssmEnvStore(ssm, path));
    byPath.set(path, store);
  }
  return store;
}

/**
 * Writes the env names for the vendors' keys (`EXA_API_KEY`, `_1..n`, `NUM_EXA`)
 * into the sink, from every key the owner holds. Call it after each key write.
 * Returns the names it put and removed.
 */
export function projectKeysFor(
  settings: Settings,
  ssm: SSMClient = ssmFor(settings),
): (vendors: string[]) => Promise<{ put: string[]; removed: string[] }> {
  const store = keyStoreFor(settings, ssm);
  const sink = sinkFor(settings, ssm);
  return async (vendors) =>
    applyProjection(sink, await ownerKeysIn(store, settings.owner), { vendors });
}

/**
 * What a workflow that mints an API key keeps it with: the owner's vault, the
 * projection that follows, and the login its browser signs in with. One per
 * settings, so a run and the handlers share the same store.
 */
export function keyKeeperFor(settings: Settings): KeyKeeper {
  const store = keyStoreFor(settings);
  const project = projectKeysFor(settings);
  return {
    owner: settings.owner,
    put: (key) => store.put(key),
    get: (address) => store.get(address),
    project,
    // The stored credential the browser signs in with (`anthropic` or its `anthropic@<role>`), else the site name.
    login: async (site) => (await credentialsFor(settings, { armed: false }).keyOf(site)) ?? site,
  };
}

/** The `keys` handlers' logic over the owner's vault, projection and audit. */
export function keyAdminFor(settings: Settings): KeyAdmin {
  return keyAdmin({
    store: keyStoreFor(settings),
    audit: auditFor(settings),
    project: projectKeysFor(settings),
    owner: settings.owner,
  });
}

/**
 * What a process hands the ring: the vault's keys (env names when the vault has none
 * or fails), the audit and the call counter. One per settings, so the cache holds.
 */
const keyDeps = new WeakMap<Settings, KeysDep>();
export function keysDepFor(settings: Settings): KeysDep {
  let dep = keyDeps.get(settings);
  if (!dep) {
    dep = {
      source: vaultSource({
        store: keyStoreFor(settings),
        owner: settings.owner,
        env: reachEnv(() => envStoreFor(settings)),
        onError: (e) =>
          console.error(`key vault unreachable; using the env keys: ${(e as Error).message}`),
      }),
      audit: auditFor(settings),
      owner: settings.owner,
      uses: fileKeyUses(join(dirname(expandHome(settings.capsFile)), "key-uses.json")),
    };
    keyDeps.set(settings, dep);
  }
  return dep;
}

export function memoryFor(settings: Settings, http = httpClient()): Memory {
  if (settings.memory === "backboard" && settings.backboardApiKey)
    return backboardMemory({
      apiKey: settings.backboardApiKey,
      http,
      assistant: settings.backboardAssistant,
    });
  return memoryStore();
}
