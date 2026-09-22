/**
 * Enroll a passkey on a site with our own virtual authenticator, then keep
 * the credential it minted: stored sealed on the site's credential and
 * loaded into every later session for that site. From then on the site's
 * "use your passkey" step completes by itself: no password, no code.
 */
import { defineFlow } from "../browser/flow.js";
import { redactText } from "../recorder/redact.js";
import type { CredentialStore } from "./credentials.js";
import { LoginFailed, type SiteLogin } from "./login.js";
import { codesOn, readRecoveryCodes, sealCodes } from "./recovery.js";

const CEREMONY_MS = 15_000;
const CONFIRM_MS = 20_000;
/** What the key is called in the site's device list. */
const PASSKEY_NAME = "autobrowse";

export function enrollPasskeyFlow(
  login: Pick<SiteLogin, "site" | "credential" | "passkeySetup" | "recoveryCodes">,
  store: CredentialStore,
) {
  const spec = login.passkeySetup;
  if (!spec)
    throw new LoginFailed(login.site, "enroll passkey: no passkey page known for the site");
  const credName = login.credential ?? login.site;
  return defineFlow<undefined, string>({
    site: login.site,
    name: "enroll-passkey",
    async run(fp) {
      const cred = await store.get(credName);
      if (!cred) throw new LoginFailed(login.site, `enroll passkey: no credential for ${credName}`);
      const before = new Set((await fp.passkeys.export()).map((p) => p.credentialId));
      await fp.open(typeof spec.url === "string" ? spec.url : spec.url(cred));
      for (const step of spec.before ?? [])
        if (await fp.has(step, 5_000))
          await fp.act({ kind: "click" }, step, { goal: "toward adding a key" });
      if (spec.name)
        await fp.act({ kind: "fill", value: PASSKEY_NAME }, spec.name, { goal: "name the key" });
      await fp.act({ kind: "click" }, spec.create, { goal: "create a passkey" });
      for (const step of spec.confirmations ?? [])
        if (await fp.has(step, 5_000))
          await fp.act({ kind: "click" }, step, { goal: "continue the passkey enrollment" });
      // The ceremony is answered by the authenticator; give the page a moment to finish it.
      let minted = [] as Awaited<ReturnType<typeof fp.passkeys.export>>;
      for (let waited = 0; waited < CEREMONY_MS && !minted.length; waited += 1_000) {
        await fp.wait(1_000);
        minted = (await fp.passkeys.export()).filter((p) => !before.has(p.credentialId));
      }
      if (!minted.length) return fp.human("no passkey was minted (the page never called WebAuthn)");
      await store.put(credName, { ...cred, passkeys: [...cred.passkeys, ...minted] });
      // The site saves the key after the ceremony ("Waiting…"); give it time to say so.
      let text = "";
      for (let waited = 0; waited < CONFIRM_MS; waited += 1_000) {
        text = (await fp.text()).replace(/\s+/g, " ");
        if (spec.done.test(text)) break;
        await fp.wait(1_000);
      }
      const confirmed = spec.done.test(text);
      // Recovery codes: shown now or kept on the site's recovery page. Sealed, only counted.
      const rc = login.recoveryCodes;
      let codes = rc ? codesOn(text, rc.codes) : [];
      if (rc && !codes.length && confirmed) codes = await readRecoveryCodes(fp, rc, cred);
      if (codes.length) await sealCodes(store, credName, codes);
      const kept = codes.length ? ` and ${codes.length} recovery codes` : "";
      const masked = codes.reduce((t, c) => t.replaceAll(c, "•••"), text);
      return confirmed
        ? `passkey enrolled for ${credName}${kept}`
        : `passkey stored for ${credName}${kept}; page did not confirm, says: ${redactText(masked.slice(0, 200))}`;
    },
  });
}
