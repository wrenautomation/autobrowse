/**
 * Making an account. The password is minted here and stored sealed
 * before the browser opens, so a signup that stalls half-way still has
 * it; the page gets it by name (`place {secret:"password"}`) and the
 * model driving the signup never sees a value. Codes the site emails or
 * texts come from the same sources sign-in uses.
 */

import type { Credential, CredentialStore } from "credvault";
import { newPassword } from "credvault";
import type { HttpClient } from "../clients/http.js";
import { gmailOAuth } from "../sites/gmail.js";
import { createRegistryUser, NPM_TOKEN } from "../sites/npm.js";
import { accountEnv } from "../sites/oauth.js";
import type { CodeSource } from "./codes.js";

/** Values a page gets by name and the model never sees; null when there is no such secret. */
export type SecretValues = (name: string) => Promise<string | null>;

/**
 * What a signup can place: the address, the minted password, a code from
 * the inbox, our phone number (`phone` as stored, `phoneLocal` without the
 * country code for a field with its own country picker).
 */
export const SIGNUP_SECRETS = ["email", "password", "code", "phone", "phoneLocal"] as const;

/** `+15875550100` → `5875550100`: the national part, for a field whose country code is a picker (only +1 is split; other codes stay as digits). */
export function localPhone(e164: string): string {
  const digits = e164.replace(/[^\d]/g, "");
  if (e164.startsWith("+1") || (digits.length === 11 && digits.startsWith("1")))
    return digits.slice(1);
  return digits;
}

/** "+1 (US/Canada)" or the code alone: what to pick in a country selector. */
export function phoneCountry(e164: string): string {
  if (e164.startsWith("+1")) return "+1 (Canada or United States)";
  const m = e164.match(/^\+(\d{1,3})/);
  return m ? `+${m[1]}` : "the number's own";
}

export interface SignupSecretsOptions {
  cred: Credential;
  codes: CodeSource;
  /** Codes older than this are an earlier attempt's. */
  since: Date;
  /** The number the site may text; the paired phone or Twilio. */
  phone?: string | null;
  now?: () => Date;
}

/** The newest code sent to the credential's inbox or phone after `since`, email first. */
export async function nextCode(
  codes: CodeSource,
  cred: Credential,
  since: Date,
): Promise<string | null> {
  for (const kind of ["email", "sms"] as const) {
    if (!codes.offers(kind, cred)) continue;
    const code = await codes.get({ site: "signup", kind, since }, cred);
    if (code) return code;
  }
  return null;
}

/**
 * Just `code`, from an inbox this system can read: what an agent run on an
 * existing account places when the site emails a code (a changed address,
 * a new device). The inbox stands in for a credential; nothing else is read.
 */
export function codeSecrets(codes: CodeSource, inbox: string, since: Date): SecretValues {
  const cred: Credential = { username: inbox, codesInbox: inbox, recoveryCodes: [], passkeys: [] };
  let from = since;
  return async (name) => {
    if (name !== "code") return null;
    const code = await nextCode(codes, cred, from);
    if (code) from = new Date();
    return code;
  };
}

/** The secrets a signup places, backed by the stored credential and the code sources. */
export function signupSecrets(o: SignupSecretsOptions): SecretValues {
  let since = o.since;
  return async (name) => {
    switch (name) {
      case "email":
        return o.cred.username;
      case "username":
        return o.cred.username;
      case "password":
        return o.cred.password ?? null;
      case "phone":
        return o.phone ?? null;
      case "phoneLocal":
        return o.phone ? localPhone(o.phone) : null;
      case "code": {
        const code = await nextCode(o.codes, o.cred, since);
        // The next code the site sends is a new one: a resend, a second step.
        if (code) since = (o.now ?? (() => new Date()))();
        return code;
      }
      default:
        return null;
    }
  };
}

/**
 * Where a signup's secrets may be placed: hosts that carry the site's name
 * (`instagram` → www.instagram.com), or the signup URL's own host.
 */
export function signupHosts(site: string, url?: string | null): (host: string) => boolean {
  const word = site.split("@")[0]?.toLowerCase() ?? site;
  const own = url ? new URL(url).host.toLowerCase() : null;
  return (host) =>
    host.toLowerCase().includes(word) || (own !== null && host.toLowerCase() === own);
}

/**
 * Whether codes sent to `inbox` can be read: it consented (`GMAIL_REFRESH_TOKEN__<IT>`)
 * or it is in the Workspace the service account is delegated for.
 */
export function signupInbox(
  inbox: string,
  o: { env: (name: string) => string | undefined; workspaceDomain: string | null },
): boolean {
  if (o.env(accountEnv(gmailOAuth.refreshToken, inbox))) return true;
  const domain = inbox.split("@")[1]?.toLowerCase();
  return Boolean(o.workspaceDomain && domain === o.workspaceDomain.toLowerCase());
}

export interface NewAccount {
  site: string;
  /** The address the account is made with. */
  email: string;
  /** Where its codes are read from, when `email` is an alias of another inbox. */
  inbox?: string;
  /** Shown name, handle, birthday: what the form asks beside the secrets. */
  name?: string;
  handle?: string;
  birthday?: string;
}

/**
 * Mint the password and store the credential under `site` first. Refuses
 * to overwrite: an account that exists is signed into, not made twice.
 */
export async function mintCredential(
  store: CredentialStore,
  a: Pick<NewAccount, "site" | "email" | "inbox">,
  password: string = newPassword(),
): Promise<Credential> {
  const had = await store.get(a.site);
  // The same address again is the same attempt (a signup that stalled): its minted password stands.
  if (had && had.username.toLowerCase() === a.email.toLowerCase() && had.password) return had;
  if (had)
    throw new Error(
      `${a.site} already has a stored credential; sign in with it, or store the new account under another name`,
    );
  await store.put(a.site, { username: a.email, password, codesInbox: a.inbox ?? a.email });
  const cred = await store.get(a.site);
  if (!cred) throw new Error(`${a.site}: the credential did not store`);
  return cred;
}

/** The agent's goal text for a signup; the secrets are named, never valued. */
export function signupGoal(a: NewAccount, phone?: string | null): string {
  const facts = [
    a.name ? `name "${a.name}"` : null,
    a.handle ? `username/handle "${a.handle}" (or the closest free one)` : null,
    a.birthday ? `birthday ${a.birthday}` : null,
  ].filter(Boolean);
  return [
    `Create a new ${a.site} account and end signed in to it.`,
    `Sign up with the email address when the site offers it. Fill the email address with place{secret:"email"}, every password field with place{secret:"password"}, a code the site emailed or texted with place{secret:"code"}, and a phone number field with place{secret:"phone"}.`,
    phone
      ? `When the phone field has its own country-code picker, pick ${phoneCountry(phone)} and place{secret:"phoneLocal"} (the number without the country code) instead.`
      : null,
    facts.length ? `Other details: ${facts.join(", ")}.` : null,
    `Decline optional extras (contacts, ads, trials). At a captcha or a step you cannot fill, return human{reason}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Signup pages a person fills in their own browser, because the site
 * guards them with a bot check this system does not defeat. `signup
 * <site> --by-hand` opens it with the minted password on the clipboard.
 */
export const SIGNUP_PAGES: Record<string, string> = {
  npm: "https://www.npmjs.com/signup",
};

export interface ApiSignupResult {
  /** A token the call answered with, and the env name to keep it under; null when it answered none. */
  token: { name: string; value: string } | null;
  /** What the site said, for the person reading the run. */
  note: string;
}

/** What an API signup is handed: the sealed credential and the door. */
export type ApiSignup = (o: {
  http: HttpClient;
  cred: Credential;
  /** The username the site wants beside the address. */
  handle: string | null;
}) => Promise<ApiSignupResult>;

/**
 * Sites whose account is made by a call, not by filling a page. npm's
 * signup page sits behind a bot check that never clears, headless or
 * headed; its registry makes the same account in one request. Where this
 * exists the browser never opens, so there is nothing to hand off at.
 */
export const API_SIGNUPS: Record<string, ApiSignup> = {
  npm: async ({ http, cred, handle }) => {
    if (!handle)
      throw new Error("npm needs a username beside the address: signup npm --handle <name>");
    if (!cred.password)
      throw new Error("the minted password is missing from the stored credential");
    const made = await createRegistryUser(http, {
      name: handle,
      email: cred.username,
      password: cred.password,
    });
    return {
      token: made.token ? { name: NPM_TOKEN, value: made.token } : null,
      note: made.note,
    };
  },
};
