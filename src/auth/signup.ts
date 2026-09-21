/**
 * Making an account. The password is minted here and stored sealed
 * before the browser opens, so a signup that stalls half-way still has
 * it; the page gets it by name (`place {secret:"password"}`) and the
 * model driving the signup never sees a value. Codes the site emails or
 * texts come from the same sources sign-in uses.
 */
import type { CodeSource } from "./codes.js";
import type { Credential, CredentialStore } from "./credentials.js";
import { newPassword } from "./rotate.js";

/** Values a page gets by name and the model never sees; null when there is no such secret. */
export type SecretValues = (name: string) => Promise<string | null>;

/** What a signup can place: the address, the minted password, a code from the inbox, our phone number. */
export const SIGNUP_SECRETS = ["email", "password", "code", "phone"] as const;

export interface SignupSecretsOptions {
  cred: Credential;
  codes: CodeSource;
  /** Codes older than this are an earlier attempt's. */
  since: Date;
  /** The number the site may text; the paired phone or Twilio. */
  phone?: string | null;
  now?: () => Date;
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
      case "code": {
        for (const kind of ["email", "sms"] as const) {
          if (!o.codes.offers(kind, o.cred)) continue;
          const code = await o.codes.get({ site: "signup", kind, since }, o.cred);
          if (code) {
            // The next code the site sends is a new one: a resend, a second step.
            since = (o.now ?? (() => new Date()))();
            return code;
          }
        }
        return null;
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
  if (await store.get(a.site))
    throw new Error(
      `${a.site} already has a stored credential; sign in with it, or store the new account under another name`,
    );
  await store.put(a.site, { username: a.email, password, codesInbox: a.inbox ?? a.email });
  const cred = await store.get(a.site);
  if (!cred) throw new Error(`${a.site}: the credential did not store`);
  return cred;
}

/** The agent's goal text for a signup; the secrets are named, never valued. */
export function signupGoal(a: NewAccount): string {
  const facts = [
    a.name ? `name "${a.name}"` : null,
    a.handle ? `username/handle "${a.handle}" (or the closest free one)` : null,
    a.birthday ? `birthday ${a.birthday}` : null,
  ].filter(Boolean);
  return [
    `Create a new ${a.site} account and end signed in to it.`,
    `Fill the email address with place{secret:"email"}, every password field with place{secret:"password"}, a code the site emailed or texted with place{secret:"code"}, and a phone number field with place{secret:"phone"}.`,
    facts.length ? `Other details: ${facts.join(", ")}.` : null,
    `Decline optional extras (contacts, ads, trials). At a captcha or a step you cannot fill, return human{reason}.`,
  ]
    .filter(Boolean)
    .join(" ");
}
