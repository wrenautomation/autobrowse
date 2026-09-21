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
import { type Cipher, isSealed, plainCipher } from "./cipher.js";
import { PROVIDERS } from "./providers.js";

export const credentialSchema = z
  .object({
    username: z.string().min(1),
    /** Absent when the account has none: it signs in through a provider (`via`). */
    password: z.string().min(1).optional(),
    /** The password before the last rotation: tried once when the site rejects the current one. */
    previousPassword: z.string().min(1).optional(),
    /** Base32 TOTP seed (the site's "manual entry key", spaces and dashes allowed); never a 6-digit code. */
    totpSecret: z
      .string()
      .transform((s) => s.replace(/[\s=-]/g, "").toUpperCase())
      .pipe(
        z
          .string()
          .regex(
            /^[A-Z2-7]{16,}$/,
            "totpSecret must be the base32 seed (16+ letters/digits), not a 6-digit code",
          ),
      )
      .optional(),
    /** One-time recovery codes the site handed out; used, then dropped. */
    recoveryCodes: z.array(z.string().min(1)).default([]),
    /** Where the site sends email codes; defaults to `username` when that is an address. */
    codesInbox: z.string().email().optional(),
    /** Passkeys enrolled by us (the virtual authenticator's export); loaded into the site's browser session. */
    passkeys: z
      .array(
        z.object({
          rpId: z.string(),
          credentialId: z.string(),
          privateKey: z.string(),
          userHandle: z.string().optional(),
          signCount: z.number(),
          isResidentCredential: z.boolean(),
        }),
      )
      .default([]),
    /** Sign in through this identity provider's button instead of a password; the provider's own credential does the work. */
    via: z.enum(PROVIDERS).optional(),
    /** Where the sign-in page is, for a site autobrowse has no login spec of its own for. */
    url: z.string().url().optional(),
  })
  .refine((c) => c.password || c.via, { message: "a credential has a password or a via provider" });

export type Credential = z.infer<typeof credentialSchema>;
export type CredentialInput = z.input<typeof credentialSchema>;

export interface CredentialStore {
  get(site: string): Promise<Credential | null>;
  put(site: string, cred: CredentialInput): Promise<void>;
  /** Site names only; never values. */
  list(): Promise<string[]>;
}

const fileSchema = z.object({ sites: z.record(z.string(), credentialSchema) });

/**
 * `{ "sites": { "<site>": Credential } }` at `path`, mode 0600, written
 * atomically, sealed with `cipher` (a plain file written earlier is still
 * read, and sealed on the next write).
 */
export function fileCredentials(path: string, cipher: Cipher = plainCipher): CredentialStore {
  const file = expandHome(path);
  const read = () => {
    if (!existsSync(file)) return { sites: {} as Record<string, Credential> };
    const raw = readFileSync(file, "utf8");
    return fileSchema.parse(JSON.parse(isSealed(raw) ? cipher.open(raw) : raw));
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
      writeFileSync(tmp, cipher.seal(JSON.stringify(data, null, 2)), { mode: 0o600 });
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
      const via = env[key(site, "VIA")];
      return credentialSchema.parse({
        username,
        password,
        ...(totpSecret ? { totpSecret } : {}),
        ...(via ? { via } : {}),
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

/** First store that has the site wins; writes go to `write`, which defaults to the last store. */
export function layeredCredentials(
  stores: CredentialStore[],
  write: CredentialStore | undefined = stores.at(-1),
): CredentialStore {
  const first = write;
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
