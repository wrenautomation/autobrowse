/**
 * The credential file at rest. AES-256-GCM with a key that lives in the
 * macOS Keychain (made on first use, read through `security -i` so it is
 * never on a command line). Elsewhere (Linux, a container) credentials
 * come from env and the file cipher is plain, said out loud in the log.
 */
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Cipher {
  seal(plain: string): string;
  open(sealed: string): string;
}

export const plainCipher: Cipher = { seal: (p) => p, open: (s) => s };

const MAGIC = "autobrowse-sealed-v1";

/** Sealed text is one JSON line: {magic, iv, tag, data}, all base64. */
export function aesGcmCipher(key: Buffer): Cipher {
  if (key.length !== 32) throw new Error("cipher key must be 32 bytes");
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return JSON.stringify({
        magic: MAGIC,
        iv: iv.toString("base64"),
        tag: c.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      });
    },
    open(sealed) {
      const parsed = JSON.parse(sealed) as {
        magic?: string;
        iv?: string;
        tag?: string;
        data?: string;
      };
      if (parsed.magic !== MAGIC || !parsed.iv || !parsed.tag || !parsed.data)
        throw new Error("credential file is not sealed by this tool");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
      d.setAuthTag(Buffer.from(parsed.tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(parsed.data, "base64")), d.final()]).toString(
        "utf8",
      );
    },
  };
}

export function isSealed(text: string): boolean {
  return text.trimStart().startsWith(`{"magic":"${MAGIC}"`);
}

const SERVICE = "autobrowse";
const ACCOUNT = "credentials-key";

/** Runs `security` in interactive mode so nothing secret is an argv. */
function security(commands: string): { status: number; out: string } {
  const r = spawnSync("security", ["-i"], { input: `${commands}\n`, encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

/** The item trusts the `security` tool itself, so reading it never raises the Keychain dialog. */
const TRUST = "-T /usr/bin/security";

function store(hex: string): void {
  const added = security(`add-generic-password -s ${SERVICE} -a ${ACCOUNT} -w ${hex} -U ${TRUST}`);
  if (added.status !== 0)
    throw new Error(
      `keychain: could not store the credential key (${added.out.trim().slice(0, 120)})`,
    );
}

/**
 * The 32-byte key from the login Keychain; created on first use with the
 * `security` tool trusted, so no dialog on later reads. Throws off macOS
 * or when the Keychain says no.
 */
export function keychainKey(): Buffer {
  if (process.platform !== "darwin") throw new Error("keychain cipher needs macOS");
  const found = security(`find-generic-password -s ${SERVICE} -a ${ACCOUNT} -w`);
  const hex = found.out.match(/\b[0-9a-f]{64}\b/)?.[0];
  if (found.status === 0 && hex) return Buffer.from(hex, "hex");
  const fresh = randomBytes(32).toString("hex");
  store(fresh);
  return Buffer.from(fresh, "hex");
}

/** Re-store the existing key with the tool trusted (an item made before `TRUST` prompts on every read). */
export function trustKeychainKey(): "retrusted" | "none" {
  const found = security(`find-generic-password -s ${SERVICE} -a ${ACCOUNT} -w`);
  const hex = found.out.match(/\b[0-9a-f]{64}\b/)?.[0];
  if (found.status !== 0 || !hex) return "none";
  security(`delete-generic-password -s ${SERVICE} -a ${ACCOUNT}`);
  store(hex);
  return "retrusted";
}
