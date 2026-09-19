/**
 * Turn on TOTP for a site ourselves: open its two-factor page, read the
 * seed the page shows, confirm with a code we generate, store the seed.
 * From then on the login needs nobody. `readSecretFromPage` is the
 * site-agnostic half; the page walk is per site.
 */
import type { FlowPage } from "../browser/flow.js";
import type { CredentialStore } from "./credentials.js";
import { LoginFailed } from "./login.js";
import { findTotpSecret, totp } from "./totp.js";

/** The seed on the current page: the otpauth link behind the QR, or the manual key. */
export async function readSecretFromPage(fp: FlowPage): Promise<string | null> {
  const html = await fp.html();
  return findTotpSecret(html) ?? findTotpSecret(await fp.text());
}

/** Record a freshly enrolled seed and prove it by producing a code the caller submits. */
export async function storeSeed(
  store: CredentialStore,
  site: string,
  secret: string,
  now: () => number = Date.now,
): Promise<string> {
  const cred = await store.get(site);
  if (!cred) throw new LoginFailed(site, "enroll TOTP: no credential stored for the site");
  await store.put(site, { ...cred, totpSecret: secret });
  return totp(secret, { at: now() });
}
