/**
 * A one-time link to stored secrets (wren designs/2026-10-06-credential-links.md).
 * `{label, fields}` is sealed here with AES-GCM under a fresh key; only the ciphertext goes to
 * wren's phone Worker, HMAC signed with `CRED_LINK_SECRET`. The key rides in the link's
 * fragment, which a browser never sends, so the Worker never holds a secret.
 */
import { createCipheriv, createHmac, randomBytes } from "node:crypto";

/** The header the Worker checks: hex HMAC-SHA256 of the body (apps/phone `LINK_SIGNATURE`). */
export const LINK_SIGNATURE = "x-wren-signature-256";

/** One Copy button on the page: `username`, `dynadot password`, `DYNADOT_API_KEY`. */
export interface LinkField {
  name: string;
  value: string;
}

/** What a link holds. The label shows before Reveal, so it names, never holds, a secret. */
export interface LinkSecrets {
  label: string;
  fields: LinkField[];
}

export interface LinkOptions {
  /** Opens without Wren's sign-in, for someone outside Wren: the link alone is the key. */
  open?: boolean | undefined;
  /** Seconds until it dies unopened, 60 to 7 days. The Worker's default is 10 minutes. */
  ttl?: number | undefined;
}

/** Mint one link: `<base>/c/<id>#<key>`. Dead after one reveal or its TTL. */
export async function mintCredentialLink(
  base: string,
  secret: string,
  secrets: LinkSecrets,
  opts: LinkOptions = {},
  post: typeof fetch = fetch,
): Promise<string> {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  // WebCrypto's AES-GCM output is the ciphertext with the tag on the end.
  const data = Buffer.concat([c.update(JSON.stringify(secrets)), c.final(), c.getAuthTag()]);
  const body = JSON.stringify({
    label: secrets.label,
    iv: iv.toString("base64"),
    data: data.toString("base64"),
    at: Date.now(),
    ...(opts.open ? { open: true } : {}),
    ...(opts.ttl ? { ttl: opts.ttl } : {}),
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

/** `10m`, `24h`, `7d` (or bare seconds) as seconds. */
export function linkTtl(text: string): number {
  const m = /^(\d+)([smhd]?)$/.exec(text.trim());
  if (!m) throw new Error(`--ttl ${text}: want 10m, 24h or 7d`);
  const s = Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as "" | "s"];
  if (s < 60 || s > 7 * 86_400) throw new Error(`--ttl ${text}: 1 minute to 7 days`);
  return s;
}

/** The label before Reveal: what's inside by name, in the characters the Worker takes. */
export function linkLabel(names: string[]): string {
  return names
    .join(", ")
    .replace(/[^\w .,@+:-]/g, "-")
    .slice(0, 100);
}
