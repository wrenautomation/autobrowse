/**
 * A one-time link to stored secrets (wren designs/2026-10-06-credential-links.md).
 * `{label, fields}` is sealed here with AES-GCM under a fresh key; only the ciphertext goes to
 * wren's phone Worker, HMAC signed with `CRED_LINK_SECRET`. The key rides in the link's
 * fragment, which a browser never sends, so the Worker never holds a secret.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

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

/** A body to the Worker, HMAC signed like a mint: `{...body, at}`. */
async function signedPost(url: string, secret: string, body: object, post: typeof fetch) {
  const raw = JSON.stringify({ ...body, at: Date.now() });
  return post(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [LINK_SIGNATURE]: createHmac("sha256", secret).update(raw).digest("hex"),
    },
    body: raw,
  });
}

/** A drop: the link to send, and the key only this process holds. */
export interface Drop {
  id: string;
  link: string;
  key: Buffer;
}

/**
 * A link the other way (`files ask`, designs/2026-10-12-papers.md and 2026-10-20-files.md):
 * `<base>/u/<id>#<key>`. Its page seals a file in the sender's browser under the key and posts
 * only ciphertext; `takeDrop` opens it.
 */
export async function mintDrop(
  base: string,
  secret: string,
  label: string,
  opts: LinkOptions = {},
  post: typeof fetch = fetch,
): Promise<Drop> {
  const root = base.replace(/\/+$/, "");
  const res = await signedPost(
    `${root}/drops`,
    secret,
    { label, ...(opts.open ? { open: true } : {}), ...(opts.ttl ? { ttl: opts.ttl } : {}) },
    post,
  );
  if (!res.ok) throw new Error(`phone Worker ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { id } = (await res.json()) as { id: string };
  const key = randomBytes(32);
  return { id, key, link: `${root}/u/${id}#${key.toString("base64url")}` };
}

/** The drop's file once sent (and gone from the Worker), null while it waits. */
export async function takeDrop(
  base: string,
  secret: string,
  drop: Pick<Drop, "id" | "key">,
  post: typeof fetch = fetch,
): Promise<Buffer | null> {
  const root = base.replace(/\/+$/, "");
  const res = await signedPost(`${root}/drops/${drop.id}/take`, secret, {}, post);
  if (res.status === 404) throw new Error("the drop is used or expired: ask again");
  if (!res.ok) throw new Error(`phone Worker ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const got = (await res.json()) as { waiting?: true; iv?: string; data?: string };
  if (got.waiting || !got.iv || !got.data) return null;
  const sealed = Buffer.from(got.data, "base64");
  const d = createDecipheriv("aes-256-gcm", drop.key, Buffer.from(got.iv, "base64"));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
}
