/**
 * `autobrowse creds key …`: API keys as credentials. A key has a vendor, a
 * label, an owner and purposes, and lives in the vault (`credvault` keys),
 * not in the env file. The env names (`EXA_API_KEY`, `_1..n`, `NUM_EXA`) are
 * the vault's projection: every write here re-projects its vendor. A value
 * arrives from the clipboard, stdin or a hidden prompt, never as an argument,
 * and is never printed, logged or put in an error.
 */
import type { Command } from "commander";
import {
  type ApiKey,
  apiKeySchema,
  type EnvStore,
  isProjectedName,
  type KeyInfo,
  type KeyStore,
  keyAddress,
  keyId,
  keysFromEnv,
  keyUses,
  liveAt,
  movePurposes,
  parseKeyAddress,
  parseVendorKeyName,
  projectionDiff,
  type SecretAudit,
  type SecretUse,
  vendorBase,
} from "credvault";
import { isDefaultOwner } from "../owner.js";
import { nextMonthUtc } from "../reach/key-ring.js";
import { ownerKeysIn } from "../reach/key-source.js";
import { cleanValue, pasteboard, secretInput } from "./cli-env.js";
import type { Settings } from "./config.js";
import { OPERATOR_TOOL_KEYS } from "./owner.js";

export interface KeysCliDeps {
  /** The vault. */
  keys: () => KeyStore;
  /** The store the projection writes (the sink): what `project --check` and `migrate` compare to the vault. */
  env: () => EnvStore;
  /** Writes the env names for these vendors from the vault; answers the names it put and removed. */
  project: (vendors: string[]) => Promise<{ put: string[]; removed: string[] }>;
  audit: () => SecretAudit;
  /** What is on the clipboard, for `add --clipboard`. */
  paste?: () => Promise<string>;
  /** The value from stdin or a hidden prompt. */
  input?: (name: string) => Promise<string>;
  say?: (line: string) => void;
  /** Set the exit code (a failed check). */
  exit?: (code: number) => void;
  now?: () => number;
}

/** The vendors whose keys the operator pays for and every owner uses: `exa`, `perplexity`, `brave`, `jina`. */
const operatorVendors = (): Set<string> =>
  new Set(
    [...OPERATOR_TOOL_KEYS]
      .map((n) => parseVendorKeyName(n)?.vendor)
      .filter((v): v is string => Boolean(v)),
  );

const day = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : "");

export function registerKeyCommands(creds: Command, settings: Settings, deps: KeysCliDeps): void {
  const say = deps.say ?? ((l: string) => console.log(l));
  const exit =
    deps.exit ??
    ((code: number) => {
      process.exitCode = code;
    });
  const now = deps.now ?? Date.now;
  const owner = settings.owner;

  /** Re-project one vendor and say which names changed. */
  const reproject = async (vendor: string): Promise<void> => {
    const { put, removed } = await deps.project([vendor]);
    const parts = [
      put.length ? `put ${put.join(", ")}` : "",
      removed.length ? `removed ${removed.join(", ")}` : "",
    ].filter(Boolean);
    say(`env: ${parts.length ? parts.join("; ") : "no change"}`);
  };

  const keyCmd = creds
    .command("key")
    .description(
      "API keys in the vault: add, ls, spend, revoke, purpose, audit, project, migrate. The env names are their projection",
    );

  keyCmd
    .command("add <address>")
    .description(
      "Store a key as <vendor>@<label> (value: --clipboard, else piped stdin, else a hidden prompt); an existing label takes a new value",
    )
    .option("--clipboard", "read the value from the clipboard (macOS)")
    .option(
      "--purpose <purposes...>",
      "what the key is for (`default` is the one the bare env name has)",
    )
    .option("--via <credential>", "the login credential the key was minted from")
    .option("--vendor-id <id>", "the vendor's own name or id for the key")
    .option("--cap <n>", "a monthly cap on this key")
    .option(
      "--cap-unit <unit>",
      "calls or micros (micros are kept and shown, not enforced)",
      "calls",
    )
    .action(
      async (
        address: string,
        o: {
          clipboard?: boolean;
          purpose?: string[];
          via?: string;
          vendorId?: string;
          cap?: string;
          capUnit: string;
        },
      ) => {
        const { site, account } = parseKeyAddress(address);
        if (!isDefaultOwner(owner) && operatorVendors().has(site))
          throw new Error(
            `${site} is the operator's tool key: it reaches ${owner} through env, never ${owner}'s vault`,
          );
        const cap = o.cap
          ? (() => {
              const amount = Number(o.cap);
              if (!Number.isFinite(amount) || amount <= 0)
                throw new Error("--cap: want a number above 0");
              if (o.capUnit !== "calls" && o.capUnit !== "micros")
                throw new Error("--cap-unit: calls or micros");
              return { amount, unit: o.capUnit } as const;
            })()
          : undefined;
        const name = `${vendorBase(site)}_API_KEY`;
        const secret = cleanValue(
          name,
          o.clipboard
            ? await (deps.paste ?? pasteboard)()
            : await (deps.input ?? secretInput)(name),
        );
        const id = keyId(secret);
        const store = deps.keys();
        const clash = (await store.list()).find(
          (k) => k.id === id && k.address !== keyAddress(site, account),
        );
        if (clash) throw new Error(`that key is already ${clash.address}`);
        const there = await store.get(keyAddress(site, account));
        const at = new Date(now()).toISOString();
        const swapped = there && keyId(there.secret) !== id;
        const key = await store.put({
          site,
          account,
          owner,
          secret,
          purposes: o.purpose ?? there?.purposes ?? [],
          status: "live",
          madeAt: swapped || !there ? at : there.madeAt,
          ...((o.via ?? there?.via) ? { via: o.via ?? there?.via } : {}),
          ...((o.vendorId ?? there?.vendorId) ? { vendorId: o.vendorId ?? there?.vendorId } : {}),
          ...((cap ?? there?.cap) ? { cap: cap ?? there?.cap } : {}),
          previous: [
            ...(there?.previous ?? []),
            ...(swapped
              ? [
                  {
                    id: keyId(there.secret),
                    ...(there.vendorId ? { vendorId: there.vendorId } : {}),
                    revokedAt: at,
                  },
                ]
              : []),
          ],
        });
        say(
          `${there ? (swapped ? "replaced" : "kept") : "added"} ${keyAddress(key.site, key.account)} (id ${id}) for ${owner}`,
        );
        if (swapped) say("the old value is still live at the vendor: revoke it there");
        await reproject(site);
      },
    );

  keyCmd
    .command("ls")
    .description("Keys: address, owner, purposes, status, id, uses and last use; never a value")
    .option("--vendor <vendor>", "one vendor")
    .option("--all", "revoked keys too")
    .action(async (o: { vendor?: string; all?: boolean }) => {
      const used = keyUses(await deps.audit().recent(10_000));
      const rows = (await deps.keys().list()).filter(
        (k) => (!o.vendor || k.site === o.vendor) && (o.all || k.status !== "revoked"),
      );
      if (!rows.length) return say("(no keys)");
      for (const k of rows) {
        const u = used.get(k.id);
        say(
          [
            k.address.padEnd(28),
            k.owner.padEnd(10),
            (k.purposes.join(",") || "-").padEnd(16),
            statusOf(k).padEnd(24),
            k.id,
            u ? `${u.uses} uses, last ${u.lastUsedAt}` : "no uses",
            k.cap ? `cap ${k.cap.amount} ${k.cap.unit}` : "",
            k.via ? `via ${k.via}` : "",
          ]
            .filter(Boolean)
            .join("  "),
        );
      }
    });

  keyCmd
    .command("spend <address>")
    .description("Mark a key out of credit until a date (default: the 1st of next month, UTC)")
    .option("--until <date>", "an ISO date")
    .action(async (address: string, o: { until?: string }) => {
      const key = await mustGet(deps.keys(), address);
      const until = o.until ? new Date(o.until) : new Date(nextMonthUtc(now()));
      if (Number.isNaN(until.getTime())) throw new Error(`not a date: ${o.until}`);
      await deps.keys().put({ ...key, status: "spent", spentUntil: until.toISOString() });
      say(`${address} is spent until ${day(until.toISOString())}`);
      await reproject(key.site);
    });

  keyCmd
    .command("revoke <address>")
    .description("Take a key out of use for good; it stays in the vault as a record")
    .action(async (address: string) => {
      const key = await mustGet(deps.keys(), address);
      await deps
        .keys()
        .put({ ...key, status: "revoked", revokedAt: new Date(now()).toISOString() });
      say(`${address} is revoked here: revoke it at the vendor too`);
      await reproject(key.site);
    });

  keyCmd
    .command("purpose <address> <purposes...>")
    .description("Give a key these purposes, taking them from the key that held them")
    .action(async (address: string, purposes: string[]) => {
      const key = await mustGet(deps.keys(), address);
      const changed = await movePurposes(deps.keys(), address, purposes);
      for (const k of changed) say(`${k.address}: ${k.purposes.join(", ") || "-"}`);
      await reproject(key.site);
    });

  keyCmd
    .command("audit <address>")
    .description("Every use of a key (and every refusal), oldest first")
    .option("-n <count>", "the last n lines", "50")
    .action(async (address: string, o: { n: string }) => {
      const info = (await deps.keys().list()).find((k) => k.address === address);
      const lines = (await deps.audit().recent(10_000)).filter(
        (u) => u.credential === address || (info !== undefined && u.keyId === info.id),
      );
      const last = lines.slice(-(Number(o.n) || 50));
      if (!last.length) return say(`(no uses of ${address})`);
      for (const u of last) say(auditLine(u));
    });

  keyCmd
    .command("project")
    .description("Write the env names from the vault for every vendor; --check only reports")
    .option("--check", "report names that differ (ids only); exit 1 when any does")
    .action(async (o: { check?: boolean }) => {
      const keys = await ownerKeysIn(deps.keys(), owner);
      const vendors = [...new Set(keys.map((k) => k.site))].sort();
      if (o.check) {
        const diff = await projectionDiff(deps.env(), keys, { vendors });
        if (!diff.length)
          return say(`env equals the vault (${vendors.join(", ") || "no vendors"})`);
        for (const d of diff) say(`${d.name}: vault ${d.want ?? "none"}, env ${d.have ?? "none"}`);
        return exit(1);
      }
      const { put, removed } = await deps.project(vendors);
      say(`put ${put.join(", ") || "none"}; removed ${removed.join(", ") || "none"}`);
    });

  keyCmd
    .command("migrate")
    .description(
      "Move the key-shaped names in the env store into the vault. A dry run unless --apply; the env must equal what the vault will project",
    )
    .option("--apply", "write the keys (the dry run writes nothing)")
    .action(async (o: { apply?: boolean }) => {
      const env = deps.env();
      const store = deps.keys();
      const listed = (await env.list()).map((e) => e.name);
      const names = listed.filter(
        (n) => parseVendorKeyName(n) !== null || (n.startsWith("NUM_") && isProjectedName(n)),
      );
      const values = await env.getMany(names);
      const entries = names.flatMap((n) =>
        values[n] === undefined ? [] : [{ name: n, value: values[n] }],
      );
      const made = keysFromEnv(entries, { owner, madeAt: new Date(now()).toISOString() });
      const skipped = [...made.skipped];
      const keys: ApiKey[] = [];
      for (const input of made.keys) {
        const key = apiKeySchema.parse(input);
        if (!isDefaultOwner(owner) && operatorVendors().has(key.site))
          skipped.push({
            name: `${key.site}@${key.account}`,
            why: "operator tool key: it reaches owners through env",
          });
        else keys.push(key);
      }
      for (const k of keys)
        say(
          `${o.apply ? "make" : "would make"} ${keyAddress(k.site, k.account)} (id ${keyId(k.secret)}) purposes ${k.purposes.join(",") || "-"}`,
        );
      for (const s of skipped) say(`skipped ${s.name}: ${s.why}`);
      const vendors = [...new Set(keys.map((k) => k.site))].sort();

      // The env must already be what the vault would project: else the projection would change it.
      const before = await projectionDiff(env, keys, { vendors });
      if (before.length) {
        say("the env is not what these keys would project; nothing written:");
        for (const d of before)
          say(`  ${d.name}: keys ${d.want ?? "none"}, env ${d.have ?? "none"}`);
        return exit(1);
      }

      const held = await store.list();
      const fresh: ApiKey[] = [];
      for (const k of keys) {
        const id = keyId(k.secret);
        const address = keyAddress(k.site, k.account);
        const same = held.find((h) => h.id === id);
        if (same) {
          say(`already in the vault: ${same.address} (id ${id})`);
          continue;
        }
        const taken = held.find((h) => h.address === address);
        if (taken) {
          say(`${address} is held by id ${taken.id}, not ${id}; nothing written`);
          return exit(1);
        }
        fresh.push(k);
      }
      if (!o.apply) {
        say(
          `dry run: ${fresh.length} key${fresh.length === 1 ? "" : "s"} to migrate for ${vendors.join(", ") || "no vendors"}; nothing written (--apply)`,
        );
        return;
      }
      for (const k of fresh) await store.put(k);
      const { put, removed } = await deps.project(vendors);
      say(
        `projection put ${put.join(", ") || "nothing"}; removed ${removed.join(", ") || "nothing"}`,
      );
      const after = await projectionDiff(env, await ownerKeysIn(store, owner), { vendors });
      if (put.length || removed.length || after.length) {
        for (const d of after)
          say(`  ${d.name}: vault ${d.want ?? "none"}, env ${d.have ?? "none"}`);
        say("the projection changed the env or it differs from the vault: look before going on");
        return exit(1);
      }
      say(
        `migrated ${fresh.length} key${fresh.length === 1 ? "" : "s"} for ${vendors.join(", ") || "no vendors"}; env equals the vault`,
      );
    });
}

async function mustGet(store: KeyStore, address: string): Promise<ApiKey> {
  parseKeyAddress(address);
  const key = await store.get(address);
  if (!key) throw new Error(`no key ${address}`);
  return key;
}

/** `live`, `spent until 2026-11-01` or `revoked`. */
function statusOf(k: KeyInfo): string {
  if (k.status === "revoked") return "revoked";
  if (liveAt(k)) return "live";
  return k.spentUntil ? `spent until ${day(k.spentUntil)}` : "spent";
}

function auditLine(u: SecretUse): string {
  return [
    u.at,
    u.allowed ? "used   " : "REFUSED",
    `by ${u.by}`,
    u.url,
    u.reason ? `(${u.reason})` : "",
  ]
    .filter(Boolean)
    .join("  ");
}
