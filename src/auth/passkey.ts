/**
 * Enroll a passkey on a site with our own virtual authenticator, then keep
 * the credential it minted: stored sealed on the site's credential and
 * loaded into every later session for that site. From then on the site's
 * "use your passkey" step completes by itself: no password, no code.
 */
import { defineFlow } from "../browser/flow.js";
import type { CredentialStore } from "./credentials.js";
import { LoginFailed, type SiteLogin } from "./login.js";

const CEREMONY_MS = 15_000;

export function enrollPasskeyFlow(
  login: Pick<SiteLogin, "site" | "credential" | "passkeySetup">,
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
      await fp.act({ kind: "click" }, spec.create, { goal: "create a passkey" });
      for (const step of spec.then ?? [])
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
      await fp.wait(2_000);
      const text = (await fp.text()).replace(/\s+/g, " ");
      return spec.done.test(text)
        ? `passkey enrolled for ${credName}`
        : `passkey stored for ${credName}; page did not confirm, says: ${text.slice(0, 200)}`;
    },
  });
}
