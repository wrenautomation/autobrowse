/**
 * The `keys` handlers of the `sites` service (and the desk's copy): the API
 * keys wren's Accounts page shows and acts on. This module holds the shapes
 * (wren copies them by hand; it imports nothing from this repo) and the
 * logic over a key store. `service.ts` adds the Restate part: zod on the way
 * in, `TerminalError` on the way out, one `ctx.run` per call. No answer
 * carries a secret: a row is credvault's `KeyInfo` (the key minus its value)
 * plus its use count from the audit.
 */
import { type KeyInfo, type KeyStore, keyInfo, keyUses, type SecretAudit } from "credvault";
import { z } from "zod";
import { getKey, KeyError, revokeKey, rotationOf, spendKey } from "../auth/keys.js";
import { nextMonthUtc } from "../reach/key-ring.js";

/** A key as the Accounts page sees it. `uses` and `lastUsedAt` are this process's audit. */
export interface KeyRow extends KeyInfo {
  uses: number;
  lastUsedAt: string | null;
}

/** `{vendor?, all?}`: the live and spent keys of a vendor (every vendor when absent); revoked ones only with `all`. */
export const keysRequest = z.object({
  vendor: z.string().min(1).optional(),
  all: z.boolean().optional(),
});
export type KeysRequest = z.infer<typeof keysRequest>;
export interface KeysAnswer {
  keys: KeyRow[];
}

/** `keySpend`: out of credit until `until` (an ISO date); the 1st of next month, UTC, when absent. */
export const keySpendRequest = z.object({
  address: z.string().min(1),
  until: z.string().min(1).optional(),
});
export type KeySpendRequest = z.infer<typeof keySpendRequest>;
export type KeySpendAnswer = KeyRow;

/** `keyRevoke`: out of use for good, here. The vendor's own copy is revoked by hand. */
export const keyRevokeRequest = z.object({ address: z.string().min(1) });
export type KeyRevokeRequest = z.infer<typeof keyRevokeRequest>;
export interface KeyRevokeAnswer {
  key: KeyRow;
  /** The env names the re-projection put and removed; never values. */
  projected: { put: string[]; removed: string[] };
}

/** `keyRotate`: start the vendor's mint flow as a run; 501 when the vendor has none. */
export const keyRotateRequest = z.object({ address: z.string().min(1) });
export type KeyRotateRequest = z.infer<typeof keyRotateRequest>;
export interface KeyRotateAnswer {
  /** `<workflow>/<key>`: `autobrowse status <workflow> <key>` shows it. */
  run: string;
  workflow: string;
}

/** What `rotation` answers: the run to start. */
export interface KeyRotation {
  workflow: string;
  key: string;
  plan: Record<string, unknown>;
}

/** The logic behind the four handlers. */
export interface KeyAdmin {
  /** Whose keys these are: the owner whose run object `keyRotate` starts. */
  owner: string;
  list(q: KeysRequest): Promise<KeyRow[]>;
  spend(address: string, until?: string): Promise<KeyRow>;
  revoke(address: string): Promise<KeyRevokeAnswer>;
  rotation(address: string): Promise<KeyRotation>;
}

export function keyAdmin(o: {
  store: KeyStore;
  audit: SecretAudit;
  /** Make the env names equal the vault's keys for these vendors. */
  project: (vendors: string[]) => Promise<{ put: string[]; removed: string[] }>;
  owner: string;
  now?: () => number;
}): KeyAdmin {
  const now = o.now ?? Date.now;
  /** The row of the key at `address`, as it is stored now. */
  const rowAt = async (address: string): Promise<KeyRow> => {
    const info = keyInfo(await getKey(o.store, address));
    const used = keyUses(await o.audit.recent(10_000)).get(info.id);
    return { ...info, uses: used?.uses ?? 0, lastUsedAt: used?.lastUsedAt ?? null };
  };
  /** A key of another owner is not here. */
  const mine = async (address: string): Promise<KeyRow> => {
    const row = await rowAt(address);
    if (row.owner !== o.owner) throw new KeyError(404, `no key ${address}`);
    return row;
  };
  return {
    owner: o.owner,
    async list(q) {
      const used = keyUses(await o.audit.recent(10_000));
      return (await o.store.list())
        .filter(
          (k) =>
            k.owner === o.owner &&
            (!q.vendor || k.site === q.vendor) &&
            (q.all || k.status !== "revoked"),
        )
        .map((k) => ({
          ...k,
          uses: used.get(k.id)?.uses ?? 0,
          lastUsedAt: used.get(k.id)?.lastUsedAt ?? null,
        }));
    },
    async spend(address, until) {
      const key = await mine(address);
      const date = until ? new Date(until) : new Date(nextMonthUtc(now()));
      if (Number.isNaN(date.getTime())) throw new KeyError(400, `not a date: ${until}`);
      await spendKey(o.store, address, date);
      await o.project([key.site]);
      return rowAt(address);
    },
    async revoke(address) {
      const key = await mine(address);
      await revokeKey(o.store, address, now());
      const projected = await o.project([key.site]);
      return { key: await rowAt(address), projected };
    },
    async rotation(address) {
      await mine(address);
      return rotationOf(o.store, address, { owner: o.owner, now: now() });
    },
  };
}
