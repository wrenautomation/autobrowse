/**
 * TOTP (RFC 6238) with node:crypto, no dependency: the codes an
 * authenticator app would show, so a login's second factor is ours to
 * type. `findTotpSecret` pulls the seed out of an enrollment page (the
 * otpauth:// link behind the QR, or the "enter this key manually" text).
 */
import { createHmac } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`base32: bad character ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";

export interface TotpOptions {
  /** Unix ms; defaults to now. */
  at?: number;
  period?: number;
  digits?: number;
  algorithm?: TotpAlgorithm;
}

/** The code for `secret` (base32) at `at`. */
export function totp(secret: string, opts: TotpOptions = {}): string {
  const period = opts.period ?? 30;
  const digits = opts.digits ?? 6;
  const counter = Math.floor((opts.at ?? Date.now()) / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(opts.algorithm ?? "sha1", base32Decode(secret))
    .update(msg)
    .digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

/** Milliseconds until the current code rolls over; wait it out when a site rejects a code that is about to expire. */
export function totpRemainingMs(at = Date.now(), period = 30): number {
  const step = period * 1000;
  return step - (at % step);
}

export interface TotpParams {
  secret: string;
  issuer: string | null;
  account: string | null;
  digits: number;
  period: number;
  algorithm: TotpAlgorithm;
}

export function parseOtpauth(uri: string): TotpParams {
  const u = new URL(uri);
  if (u.protocol !== "otpauth:" || u.host !== "totp") throw new Error("not an otpauth://totp URI");
  const secret = u.searchParams.get("secret");
  if (!secret) throw new Error("otpauth URI has no secret");
  const label = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
  const [labelIssuer, account] = label.includes(":") ? label.split(":", 2) : [null, label];
  const algo = (u.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
  return {
    secret: secret.replace(/[\s=-]/g, "").toUpperCase(),
    issuer: u.searchParams.get("issuer") ?? labelIssuer,
    account: account || null,
    digits: Number(u.searchParams.get("digits") ?? 6),
    period: Number(u.searchParams.get("period") ?? 30),
    algorithm: algo === "sha256" || algo === "sha512" ? algo : "sha1",
  };
}

const OTPAUTH = /otpauth:\/\/totp\/[^\s"'<>]+/i;
/** 16+ base32 characters, optionally in spaced or dashed groups of 4. */
const MANUAL_KEY = /\b(?:[A-Z2-7]{4}[\s-]?){4,}[A-Z2-7]*\b/;

/** The seed in page text or HTML: a URI wins, then a manual-entry key. Null when neither is there. */
export function findTotpSecret(text: string): string | null {
  const uri = text.match(OTPAUTH);
  if (uri) {
    try {
      return parseOtpauth(uri[0].replace(/&amp;/g, "&")).secret;
    } catch {
      // fall through to a manual key
    }
  }
  const key = text.toUpperCase().match(MANUAL_KEY);
  if (!key) return null;
  const secret = key[0].replace(/[\s-]/g, "");
  return secret.length >= 16 && secret.length % 2 === 0 ? secret : null;
}
