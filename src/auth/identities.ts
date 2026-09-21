/**
 * Which of the person's accounts is for what. One address pays for things
 * (developer consoles with a card, ad accounts, model credits), another is
 * for everything else, a third for signups: a purpose names the account,
 * and every command that needs one (a signup's inbox, an OAuth consent, a
 * `via` sign-in) asks here instead of assuming. Addresses only, never a
 * secret: the credential for an address is the `<site>@<label>` entry whose
 * username it is.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { expandHome } from "../google-auth.js";

/** Where the account signs in; decides which sites' consents it can be for. */
export const IDENTITY_PROVIDERS = ["google", "microsoft"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

/** The purpose every account falls back to when none names the one asked for. */
export const DEFAULT_PURPOSE = "default";
/** Purposes the code asks for; any other word is fine too. */
export const PURPOSES = {
  default: "everything not named below",
  pays: "anything with a card or credits: developer consoles that bill, ad accounts, model credits",
  signup: "new accounts are made with this address and its inbox reads their codes",
} as const;

export const identitySchema = z.object({
  address: z.string().trim().email(),
  at: z.enum(IDENTITY_PROVIDERS).default("google"),
  for: z.array(z.string().trim().min(1)).default([]),
  note: z.string().optional(),
});
export type Identity = z.infer<typeof identitySchema>;

export interface IdentityStore {
  list(): Promise<Identity[]>;
  save(all: Identity[]): Promise<void>;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The account for a purpose: the one that names it, else the default one, else null. */
export function identityFor(all: readonly Identity[], purpose: string): Identity | null {
  return (
    all.find((i) => i.for.includes(purpose)) ??
    all.find((i) => i.for.includes(DEFAULT_PURPOSE)) ??
    null
  );
}

/** Same, but only an account at that provider (a Google consent cannot be a Microsoft account). */
export function identityAt(
  all: readonly Identity[],
  at: IdentityProvider,
  purpose: string,
): Identity | null {
  return identityFor(
    all.filter((i) => i.at === at),
    purpose,
  );
}

/** `a@x.com=pays;b@y.com=default,signup;c@z.dev@microsoft=personal` — the env form for the box. */
export function parseIdentities(text: string): Identity[] {
  return text
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [who = "", purposes = ""] = entry.split("=");
      const [address = "", at] = who.split("@").length > 2 ? splitAt(who) : [who, undefined];
      return identitySchema.parse({
        address,
        ...(at ? { at } : {}),
        for: purposes
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      });
    });
}
/** `user@host@microsoft` → address and provider. */
function splitAt(who: string): [string, string] {
  const i = who.lastIndexOf("@");
  return [who.slice(0, i), who.slice(i + 1)];
}

export function formatIdentities(all: readonly Identity[]): string {
  return all
    .map((i) => `${i.address}${i.at === "google" ? "" : `@${i.at}`}=${i.for.join(",")}`)
    .join(";");
}

/** Add or change one; a purpose held by another account moves here. */
export function withIdentity(all: readonly Identity[], id: Identity): Identity[] {
  const others = all
    .filter((i) => !same(i.address, id.address))
    .map((i) => ({ ...i, for: i.for.filter((p) => !id.for.includes(p)) }));
  return [...others, id];
}

export function withoutIdentity(all: readonly Identity[], address: string): Identity[] {
  return all.filter((i) => !same(i.address, address));
}

/** Give a purpose to an account it must already be in the list. */
export function assignPurpose(
  all: readonly Identity[],
  purpose: string,
  address: string,
): Identity[] {
  const id = all.find((i) => same(i.address, address));
  if (!id) throw new Error(`no account ${address}: accounts add ${address} first`);
  return withIdentity(all, { ...id, for: [...new Set([...id.for, purpose])] });
}

export function fileIdentities(path: string): IdentityStore {
  const file = expandHome(path);
  return {
    async list() {
      if (!existsSync(file)) return [];
      return z.array(identitySchema).parse(JSON.parse(readFileSync(file, "utf8")));
    },
    async save(all) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
    },
  };
}

/** The env form, read-only: what the box has. */
export function envIdentities(text: string | undefined): IdentityStore {
  return {
    async list() {
      return text ? parseIdentities(text) : [];
    },
    async save() {
      throw new Error("accounts from the env are read-only: edit AUTOBROWSE_ACCOUNTS");
    },
  };
}

/** The file when it has anything, else the env text. */
export function layeredIdentities(file: IdentityStore, env: IdentityStore): IdentityStore {
  return {
    async list() {
      const local = await file.list();
      return local.length ? local : env.list();
    },
    save: (all) => file.save(all),
  };
}
