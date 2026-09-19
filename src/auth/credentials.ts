/**
 * What it takes to sign in to a site, by site name. Stored outside the
 * repo and outside any journal: a 0600 JSON file locally, one secret in
 * SSM or a Kubernetes Secret when deployed. Read at the moment a login
 * needs it, never carried on a plan or in a memo.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { expandHome } from "../google-auth.js";

export const credentialSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  /** Base32 TOTP seed; set by `enrollTotp` or copied from the site's manual key. */
  totpSecret: z.string().min(16).optional(),
  /** One-time recovery codes the site handed out; used, then dropped. */
  recoveryCodes: z.array(z.string().min(1)).default([]),
  /** Where the site sends email codes; defaults to `username` when that is an address. */
  codesInbox: z.string().email().optional(),
});

export type Credential = z.infer<typeof credentialSchema>;
export type CredentialInput = z.input<typeof credentialSchema>;

export interface CredentialStore {
  get(site: string): Promise<Credential | null>;
  put(site: string, cred: CredentialInput): Promise<void>;
  /** Site names only; never values. */
  list(): Promise<string[]>;
}

const fileSchema = z.object({ sites: z.record(z.string(), credentialSchema) });

/** `{ "sites": { "<site>": Credential } }` at `path`, mode 0600, written atomically. */
export function fileCredentials(path: string): CredentialStore {
  const file = expandHome(path);
  const read = () => {
    if (!existsSync(file)) return { sites: {} as Record<string, Credential> };
    return fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  };
  return {
    async get(site) {
      return read().sites[site] ?? null;
    },
    async put(site, cred) {
      const data = read();
      data.sites[site] = credentialSchema.parse(cred);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmp, file);
    },
    async list() {
      return Object.keys(read().sites);
    },
  };
}

export function memoryCredentials(init: Record<string, CredentialInput> = {}): CredentialStore {
  const sites = new Map(Object.entries(init).map(([k, v]) => [k, credentialSchema.parse(v)]));
  return {
    async get(site) {
      return sites.get(site) ?? null;
    },
    async put(site, cred) {
      sites.set(site, credentialSchema.parse(cred));
    },
    async list() {
      return [...sites.keys()];
    },
  };
}

/**
 * `AUTOBROWSE_CRED_<SITE>_USERNAME` / `_PASSWORD` / `_TOTP_SECRET`: the
 * container form, where a Secret becomes env. Read-only.
 */
export function envCredentials(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  const key = (site: string, field: string) =>
    `AUTOBROWSE_CRED_${site.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_${field}`;
  return {
    async get(site) {
      const username = env[key(site, "USERNAME")];
      const password = env[key(site, "PASSWORD")];
      if (!username || !password) return null;
      const totpSecret = env[key(site, "TOTP_SECRET")];
      return credentialSchema.parse({
        username,
        password,
        ...(totpSecret ? { totpSecret } : {}),
      });
    },
    async put(site) {
      throw new Error(`credentials for ${site}: env store is read-only; set ${key(site, "*")}`);
    },
    async list() {
      const m = /^AUTOBROWSE_CRED_(.+)_USERNAME$/;
      return Object.keys(env)
        .map((k) => k.match(m)?.[1])
        .filter((s): s is string => Boolean(s))
        .map((s) => s.toLowerCase().replace(/_/g, "-"));
    },
  };
}

/** First store that has the site wins; writes go to the first store. */
export function layeredCredentials(...stores: CredentialStore[]): CredentialStore {
  const [first] = stores;
  if (!first) throw new Error("layeredCredentials needs at least one store");
  return {
    async get(site) {
      for (const s of stores) {
        const c = await s.get(site);
        if (c) return c;
      }
      return null;
    },
    put: (site, cred) => first.put(site, cred),
    async list() {
      const all = await Promise.all(stores.map((s) => s.list()));
      return [...new Set(all.flat())];
    },
  };
}
