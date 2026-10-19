/**
 * What changes a stored API key: rotate, spend, revoke. One module for the
 * Console flow, `creds key` and the `keys` handlers, so the rules (the new
 * key keeps the old one's address, purposes, via and cap; the old id goes to
 * `previous`) live once. Nothing here prints or returns a secret except the
 * `ApiKey` a store hands back; callers show `keyInfo(key)`.
 */
import {
  type ApiKey,
  type KeyInfo,
  type KeyStore,
  keyId,
  keyInfo,
  parseKeyAddress,
} from "credvault";

/** A caller's mistake with a status: 400 bad input, 404 no such key, 501 no mint flow for the vendor. */
export class KeyError extends Error {
  constructor(
    readonly status: 400 | 404 | 501,
    message: string,
  ) {
    super(message);
    this.name = "KeyError";
  }
}

/** The key at an address, or a `KeyError`: 400 for a malformed address, 404 for none. */
export async function getKey(store: Pick<KeyStore, "get">, address: string): Promise<ApiKey> {
  try {
    parseKeyAddress(address);
  } catch (e) {
    throw new KeyError(400, e instanceof Error ? e.message : String(e));
  }
  const key = await store.get(address);
  if (!key) throw new KeyError(404, `no key ${address}`);
  return key;
}

/**
 * The key a rotation replaces. It must exist, belong to `owner`, and be a
 * `vendor` key when one is named. Checked before anything opens a browser.
 */
export async function rotatable(
  store: Pick<KeyStore, "get">,
  address: string,
  o: { owner: string; vendor?: string },
): Promise<ApiKey> {
  const key = await getKey(store, address);
  if (key.owner !== o.owner) throw new KeyError(404, `no key ${address}`);
  if (o.vendor && key.site !== o.vendor)
    throw new KeyError(400, `${address} is not a ${o.vendor} key`);
  return key;
}

export interface RotateOptions {
  owner: string;
  /** Epoch ms. */
  now: number;
  /** The vendor the new key must be for. */
  vendor?: string;
  /** The vendor's own name for the new key (the Console name); none when made by hand. */
  vendorId?: string;
  /** The login the new key was minted from, when the old key names none. */
  via?: string;
}

/**
 * Put a new value at an existing address. The new key keeps the old one's
 * purposes, `via` and `cap`; the old id and its vendor name go first in
 * `previous` with the time of the swap. The old value stays live at the
 * vendor: the caller says to revoke it there. Answers the stored key and
 * the old key's id and vendor name.
 */
export async function rotateKey(
  store: Pick<KeyStore, "get" | "put"> & Partial<Pick<KeyStore, "list">>,
  address: string,
  newSecret: string,
  o: RotateOptions,
): Promise<{ key: ApiKey; old: { id: string; vendorId?: string } }> {
  const old = await rotatable(store, address, o);
  const oldId = keyId(old.secret);
  const id = keyId(newSecret);
  if (id === oldId) throw new KeyError(400, `that value is already ${address}`);
  // A value another address holds is a mistake; a keeper that cannot list (the Console flow's) minted this one just now.
  const clash = (await store.list?.())?.find((k) => k.id === id);
  if (clash) throw new KeyError(400, `that key is already ${clash.address}`);
  const at = new Date(o.now).toISOString();
  const via = old.via ?? o.via;
  const key = await store.put({
    site: old.site,
    account: old.account,
    owner: old.owner,
    secret: newSecret,
    purposes: old.purposes,
    status: "live",
    madeAt: at,
    ...(via ? { via } : {}),
    ...(o.vendorId ? { vendorId: o.vendorId } : {}),
    ...(old.cap ? { cap: old.cap } : {}),
    previous: [
      { id: oldId, ...(old.vendorId ? { vendorId: old.vendorId } : {}), revokedAt: at },
      ...old.previous,
    ],
  });
  return { key, old: { id: oldId, ...(old.vendorId ? { vendorId: old.vendorId } : {}) } };
}

/** Mark a key out of credit until `until`. */
export async function spendKey(store: KeyStore, address: string, until: Date): Promise<ApiKey> {
  const key = await getKey(store, address);
  return store.put({ ...key, status: "spent", spentUntil: until.toISOString() });
}

/** Take a key out of use for good; the row stays as a record. */
export async function revokeKey(store: KeyStore, address: string, now: number): Promise<ApiKey> {
  const key = await getKey(store, address);
  return store.put({ ...key, status: "revoked", revokedAt: new Date(now).toISOString() });
}

/** The vendors that can mint a key themselves, and the run that does it. Others rotate with a pasted value. */
export const ROTATORS: Record<
  string,
  {
    workflow: string;
    plan: (key: KeyInfo, address: string, day: string) => Record<string, unknown>;
  }
> = {
  anthropic: {
    workflow: "anthropic-console-api-key",
    plan: (key, address, day) => ({
      name: `${key.account}-${day}`,
      account: key.account,
      replaces: address,
      // Sign in the way the old key was made, when that login is an Anthropic one.
      ...(key.via && (key.via === "anthropic" || key.via.startsWith("anthropic@"))
        ? { login: key.via }
        : {}),
    }),
  },
};

/** `20261019`: the day in a rotated key's Console name and run key. */
export const dayOf = (now: number): string =>
  new Date(now).toISOString().slice(0, 10).replaceAll("-", "");

/** The run that rotates `address` through its vendor's flow: workflow, run key and plan. */
export async function rotationOf(
  store: Pick<KeyStore, "get">,
  address: string,
  o: { owner: string; now: number },
): Promise<{ workflow: string; key: string; plan: Record<string, unknown> }> {
  const key = await rotatable(store, address, { owner: o.owner });
  const rotator = ROTATORS[key.site];
  if (!rotator)
    throw new KeyError(
      501,
      `${key.site} has no mint flow: autobrowse creds key rotate ${address} --clipboard`,
    );
  const day = dayOf(o.now);
  return {
    workflow: rotator.workflow,
    key: `rotate-${key.account}-${day}`,
    plan: rotator.plan(keyInfo(key), address, day),
  };
}
