/**
 * Change a site's password ourselves: a new one is drawn here, typed into
 * the site's change-password page, and stored sealed; it never leaves the
 * process. The old one stays as `previousPassword` for one sign-in, in
 * case the page accepted the change without saying so.
 */

import type { CredentialStore } from "credvault";
import { newPassword } from "credvault";
import { defineFlow } from "../browser/flow.js";
import { LoginFailed, passwordOf, type SiteLogin } from "./login.js";

/** The rotation as a flow; the result says what the page confirmed. */
export function rotatePasswordFlow(
  login: Pick<SiteLogin, "site" | "credential" | "passwordChange">,
  store: CredentialStore,
  draw: () => string = () => newPassword(),
) {
  const spec = login.passwordChange;
  if (!spec)
    throw new LoginFailed(login.site, "rotate: no change-password page known for the site");
  const credName = login.credential ?? login.site;
  return defineFlow<undefined, string>({
    site: login.site,
    name: "rotate-password",
    async run(fp) {
      const cred = await store.get(credName);
      if (!cred) throw new LoginFailed(login.site, `rotate: no credential stored for ${credName}`);
      const current = passwordOf(login.site, cred);
      const next = draw();
      await fp.open(typeof spec.url === "string" ? spec.url : spec.url(cred));
      if (spec.current && (await fp.has(spec.current, 3_000)))
        await fp.act({ kind: "fill", value: current }, spec.current, {
          goal: "type the current password",
        });
      await fp.act({ kind: "fill", value: next }, spec.next, { goal: "type the new password" });
      if (spec.confirm)
        await fp.act({ kind: "fill", value: next }, spec.confirm, {
          goal: "confirm the new password",
        });
      // Stored before the click: if the site takes it and we crash right after, the store is right.
      await store.put(credName, { ...cred, password: next, previousPassword: current });
      await fp.act({ kind: "click" }, spec.submit, {
        goal: "change the password",
        irreversible: true,
      });
      await fp.wait(3_000);
      const text = (await fp.text()).replace(/\s+/g, " ");
      const confirmed = spec.done.test(text) || spec.done.test(fp.url());
      if (/too weak|already used|try another|incorrect|wrong password|didn.t match/i.test(text)) {
        await store.put(credName, cred);
        throw new LoginFailed(
          login.site,
          `rotate: the site refused the new password: ${text.slice(0, 160)}`,
        );
      }
      return confirmed
        ? `password rotated for ${credName}`
        : `password typed for ${credName}; page did not confirm (previous kept as fallback): ${text.slice(0, 160)}`;
    },
  });
}
