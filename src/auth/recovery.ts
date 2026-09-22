/**
 * Recovery codes: the way back in when the second factor is lost. A site
 * shows them once after enrollment and again on its recovery page; either
 * way they are read off the page, sealed with the credential, and only
 * counted in what we print.
 */

import type { Credential, CredentialStore } from "credvault";
import { defineFlow, type FlowPage } from "../browser/flow.js";
import type { Hints } from "../browser/locate.js";
import { LoginFailed, type RecoveryCodesSpec, type SiteLogin } from "./login.js";

const UNLOCK_WAIT_MS = 5_000;
const CEREMONY_MS = 4_000;
const LIST_MS = 15_000;

/** A page that wants the key again ("Use security key"): our authenticator answers the click. */
export async function unlockWithPasskey(fp: FlowPage, button: Hints): Promise<boolean> {
  if (!(await fp.has(button, UNLOCK_WAIT_MS))) return false;
  await fp.act({ kind: "click" }, button, { goal: "confirm it is us with our passkey" });
  await fp.wait(CEREMONY_MS);
  return true;
}

/** The codes on the current page, deduped, in page order. */
export function codesOn(text: string, codes: RegExp): string[] {
  return [...new Set(text.match(new RegExp(codes.source, codes.flags.replace("g", "") + "g")))];
}

/** Open the recovery page, unlock it, and return the codes it lists. */
export async function readRecoveryCodes(
  fp: FlowPage,
  spec: RecoveryCodesSpec,
  cred: Credential,
): Promise<string[]> {
  await fp.open(typeof spec.url === "string" ? spec.url : spec.url(cred));
  if (spec.unlock) await unlockWithPasskey(fp, spec.unlock);
  // The list renders after the unlock settles.
  for (let waited = 0; ; waited += 1_000) {
    const codes = codesOn(await fp.text(), spec.codes);
    if (codes.length || waited >= LIST_MS) return codes;
    await fp.wait(1_000);
  }
}

/** Seal the codes on the credential; what is printed is the count. */
export async function sealCodes(
  store: CredentialStore,
  credName: string,
  codes: readonly string[],
): Promise<void> {
  const cred = await store.get(credName);
  if (!cred) throw new Error(`no credential for ${credName}`);
  await store.put(credName, { ...cred, recoveryCodes: [...codes] });
}

export function sealRecoveryCodesFlow(
  login: Pick<SiteLogin, "site" | "credential" | "recoveryCodes">,
  store: CredentialStore,
) {
  const spec = login.recoveryCodes;
  if (!spec)
    throw new LoginFailed(login.site, "recovery codes: no recovery page known for the site");
  const credName = login.credential ?? login.site;
  return defineFlow<undefined, string>({
    site: login.site,
    name: "recovery-codes",
    async run(fp) {
      const cred = await store.get(credName);
      if (!cred) throw new LoginFailed(login.site, `recovery codes: no credential for ${credName}`);
      const codes = await readRecoveryCodes(fp, spec, cred);
      if (!codes.length) return fp.human("the recovery page showed no codes");
      await sealCodes(store, credName, codes);
      return `${codes.length} recovery codes sealed for ${credName}`;
    },
  });
}
