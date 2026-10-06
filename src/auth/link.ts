/**
 * A one-time link to a stored login, for the phone (wren designs/2026-10-06-credential-links.md).
 * `{site, username, password}` is sealed here with AES-GCM under a fresh key; only the
 * ciphertext goes to wren's phone Worker, HMAC signed with `CRED_LINK_SECRET`. The key rides in
 * the link's fragment, which a browser never sends, so the Worker never holds a password.
 */
import { createCipheriv, createHmac, randomBytes } from "node:crypto";

/** The header the Worker checks: hex HMAC-SHA256 of the body (apps/phone `LINK_SIGNATURE`). */
export const LINK_SIGNATURE = "x-wren-signature-256";

export interface LinkLogin {
  site: string;
  username: string;
  password: string;
}

/** Mint one link: `<base>/c/<id>#<key>`. Dead after one reveal or 10 minutes. */
export async function mintCredentialLink(
  base: string,
  secret: string,
  login: LinkLogin,
  post: typeof fetch = fetch,
): Promise<string> {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  // WebCrypto's AES-GCM output is the ciphertext with the tag on the end.
  const data = Buffer.concat([c.update(JSON.stringify(login)), c.final(), c.getAuthTag()]);
  const body = JSON.stringify({
    site: login.site,
    iv: iv.toString("base64"),
    data: data.toString("base64"),
    at: Date.now(),
  });
  const root = base.replace(/\/+$/, "");
  const res = await post(`${root}/links`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [LINK_SIGNATURE]: createHmac("sha256", secret).update(body).digest("hex"),
    },
    body,
  });
  if (!res.ok) throw new Error(`phone Worker ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { id } = (await res.json()) as { id: string };
  return `${root}/c/${id}#${key.toString("base64url")}`;
}
