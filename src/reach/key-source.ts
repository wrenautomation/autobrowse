/**
 * Where the ring's keys come from: the vault first (`creds key`), the env
 * names when the vault has none for a vendor or does not answer. The env
 * names are the vault's projection, so the fallback is the same keys.
 * Every use is a line in the audit: the key's address and id, who asked,
 * which route; never the value.
 */
import {
  type ApiKey,
  type EnvStore,
  type KeyStore,
  keyId,
  keysFor,
  liveAt,
  parseKeyAddress,
  type SecretAudit,
  vendorBase,
} from "credvault";
import {
  type AsyncEnv,
  type KeySource,
  type KeyUses,
  NoLiveKey,
  type RingKey,
  ringKeys,
  type WithKeyOptions,
} from "./key-ring.js";

/** This machine's environment first, then the env store; a store that cannot be reached is no key. */
export function reachEnv(store: () => EnvStore): AsyncEnv {
  return async (name) =>
    process.env[name] ||
    ((await store()
      .get(name)
      .catch(() => null)) ??
      undefined);
}

/** Every key of `owner` in the store with its value: what a projection is made from. */
export async function ownerKeysIn(store: KeyStore, owner: string): Promise<ApiKey[]> {
  const out: ApiKey[] = [];
  for (const info of await store.list()) {
    if (info.owner !== owner) continue;
    const key = await store.get(info.address);
    if (key) out.push(key);
  }
  return out;
}

const date = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : "");

export interface VaultSourceOptions {
  store: KeyStore;
  /** The process's owner: the only owner whose keys it reads. */
  owner: string;
  /** The env ring, read when the vault has no key for the vendor or fails. */
  env: AsyncEnv;
  /** How long a vendor's ring stands before the vault is read again. */
  ttlMs?: number;
  /** The vault read failed (once per ttl); the env ring answered. */
  onError?: (e: unknown) => void;
  now?: () => number;
}

const ringOf = (k: ApiKey, address: string): RingKey => {
  const id = keyId(k.secret);
  return {
    name: address,
    value: k.secret,
    fingerprint: id,
    id,
    address,
    ...(k.cap ? { cap: k.cap } : {}),
  };
};

/**
 * The vault as a key source. A named account answers with that key or
 * throws `NoLiveKey` saying why; it never falls back to another key. An
 * unnamed call reads the vendor's ring (`keysFor`), cached `ttlMs` per
 * vendor and purpose; the env ring answers when the vault has none or fails.
 */
export function vaultSource(o: VaultSourceOptions): KeySource {
  const ttl = o.ttlMs ?? 60_000;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; keys: RingKey[] }>();
  return async (vendor, ask) => {
    if (ask.account) return [await named(o, vendor, ask.account, now())];
    const slot = `${vendor}\n${ask.purpose ?? ""}`;
    const had = cache.get(slot);
    if (had && now() - had.at < ttl) return had.keys;
    let keys: RingKey[] = [];
    try {
      const found = await keysFor(o.store, {
        owner: o.owner,
        vendor,
        purpose: ask.purpose,
        now: now(),
      });
      keys = found.map((k) => ringOf(k, `${k.site}@${k.account}`));
    } catch (e) {
      o.onError?.(e);
    }
    if (!keys.length) keys = await ringKeys(vendorBase(vendor), o.env);
    cache.set(slot, { at: now(), keys });
    return keys;
  };
}

async function named(
  o: VaultSourceOptions,
  vendor: string,
  account: string,
  now: number,
): Promise<RingKey> {
  const refuse = (message: string): never => {
    throw new NoLiveKey(vendorBase(vendor), 0, null, { account, message });
  };
  try {
    parseKeyAddress(account);
  } catch {
    return refuse(`${account} is not a key address (${vendor}@label)`);
  }
  const key = await o.store.get(account);
  if (!key) return refuse(`no key ${account}`);
  if (key.site !== vendor) return refuse(`${account} is not a ${vendor} key`);
  if (key.owner !== o.owner) return refuse(`no key ${account}`);
  if (!liveAt(key, now))
    return refuse(
      key.status === "revoked"
        ? `${account} is revoked`
        : `${account} is spent${key.spentUntil ? ` until ${date(key.spentUntil)}` : ""}`,
    );
  return ringOf(key, account);
}

/** What a process hands the ring: where keys come from, where uses are written, whose they are. */
export interface KeysDep {
  source: KeySource;
  audit?: SecretAudit;
  /** The process's owner. */
  owner: string;
  uses?: KeyUses;
}

/** One call's key options: which key, the audit lines, the call counter. */
export interface KeyCall {
  account?: string | undefined;
  purpose?: string | undefined;
  uses?: KeyUses | undefined;
  onUse: (key: RingKey, vendor: string, endpoint: string) => Promise<void>;
  onRefuse: (account: string, why: string, vendor: string, endpoint: string) => Promise<void>;
}

/** An endpoint as the audit keeps it: no query (tokens ride there). */
const endpointOf = (url: string): string => url.split(/[?#]/)[0] ?? url;

/**
 * The options for one call: the audit line before each send, and one for a
 * named key that was refused. `by` is the caller (a command, a Restate
 * caller), `reason` the route.
 */
export function keyCall(
  dep: KeysDep,
  c: { by: string; reason: string; account?: string | undefined; purpose?: string | undefined },
): KeyCall {
  const line = (
    credential: string,
    vendor: string,
    endpoint: string,
    allowed: boolean,
    extra: { keyId?: string; reason: string },
  ) =>
    dep.audit?.record({
      at: new Date().toISOString(),
      credential,
      field: "secret",
      site: vendor,
      url: endpointOf(endpoint),
      by: c.by,
      owner: dep.owner,
      allowed,
      ...(extra.keyId ? { keyId: extra.keyId } : {}),
      reason: extra.reason,
    });
  return {
    account: c.account,
    purpose: c.purpose,
    uses: dep.uses,
    onUse: async (key, vendor, endpoint) => {
      await line(key.address ?? key.name, vendor, endpoint, true, {
        keyId: key.id,
        reason: c.reason,
      });
    },
    onRefuse: async (account, why, vendor, endpoint) => {
      // The refusal is the answer; a failed audit write must not hide it.
      await Promise.resolve(
        line(account, vendor, endpoint, false, { reason: `${c.reason}: ${why}` }),
      ).catch(() => {});
    },
  };
}

/** Adapts `keyCall` to `withKey`'s options for one vendor and endpoint. */
export function withKeyOptions(
  call: KeyCall | undefined,
  vendor: string,
  endpoint: string,
  now?: () => number,
): WithKeyOptions {
  if (!call) return { now };
  return {
    account: call.account,
    purpose: call.purpose,
    uses: call.uses,
    now,
    onUse: (key) => call.onUse(key, vendor, endpoint),
    onRefuse: (account, why) => call.onRefuse(account, why, vendor, endpoint),
  };
}
