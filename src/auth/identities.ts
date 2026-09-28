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
import { PROVIDERS } from "./providers.js";

/** Where the account signs in; decides which sites' consents it can be for. */
export const IDENTITY_PROVIDERS = ["google", "microsoft"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

/** The purpose every account falls back to when none names the one asked for. */
export const DEFAULT_PURPOSE = "default";
/**
 * Purposes the code asks for, each held by one account at a time. Any other
 * word (`sends`, `personal`) is a group: as many accounts as you like hold it.
 */
export const PURPOSES = {
  default: "everything not named below",
  pays: "anything with a card or credits: developer consoles that bill, ad accounts, model credits",
  signup: "new accounts are made with this address and its inbox reads their codes",
} as const;

/** One account at a time holds it (the code asks for "the" account for it). */
export const isExclusive = (purpose: string): boolean => Object.hasOwn(PURPOSES, purpose);

/** Every account in a group (`sends`), in the order they were added. */
export function inGroup(all: readonly Identity[], purpose: string): Identity[] {
  return all.filter((i) => i.for.includes(purpose));
}

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

/**
 * What a person types for an account, as its credential and profile name:
 * a bare address (`will@a.com`) is that address's own Google account,
 * `google@will@a.com`; a site or `site@label` (`google@wren`, `google@wj.dev`)
 * stays as it is.
 */
export function accountSite(nameOrAddress: string, at: IdentityProvider = "google"): string {
  const v = nameOrAddress.trim();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)) return v;
  // `google@wj.dev` is the label `wj.dev` on google, not the address: a
  // provider's name is never the account part of an address we sign in as.
  const local = v.slice(0, v.indexOf("@")).toLowerCase();
  if ((PROVIDERS as readonly string[]).includes(local)) return v;
  return `${at}@${v.toLowerCase()}`;
}

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

/** Add or change one, in place; an exclusive purpose (pays, default, signup) another account held moves here. */
export function withIdentity(all: readonly Identity[], id: Identity): Identity[] {
  const moved = (i: Identity) => ({
    ...i,
    for: i.for.filter((p) => !(isExclusive(p) && id.for.includes(p))),
  });
  const at = all.findIndex((i) => same(i.address, id.address));
  const rest = all.map(moved);
  if (at < 0) return [...rest, id];
  rest[at] = id;
  return rest;
}

export function withoutIdentity(all: readonly Identity[], address: string): Identity[] {
  return all.filter((i) => !same(i.address, address));
}

/** Give a purpose to an account already in the list (an exclusive one moves from whoever had it). */
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
