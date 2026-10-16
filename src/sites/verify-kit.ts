/**
 * Small helpers the per-route `verify` reads share (designs/2026-10-16-send-verdicts.md). They
 * turn a site's answer into `VerifyRow`s. The matcher itself lives in `verdict.ts`.
 */
import type { Seen } from "./verdict.js";

export type Json = Record<string, unknown>;

/** An object, or an empty one: an answer is read, never trusted. */
export const rec = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A non-empty string, else null. */
export const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
/** A string, else "". A number id comes as its digits. */
export const text = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";

/** A time as ISO. Seconds or milliseconds for a number; a string as Date reads it (`+0000` too). */
export function isoOf(v: unknown, unit: "s" | "ms" = "ms"): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : /^\d+(\.\d+)?$/.test(String(v)) ? Number(v) : NaN;
  const ms = Number.isNaN(n)
    ? Date.parse(String(v).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"))
    : unit === "s"
      ? n * 1000
      : n;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export const unclear = (why: string): Seen => ({ seen: "unclear", why });

/** A Graph-style edge has a next page. */
export const hasNext = (v: unknown): boolean => !!rec(rec(v).paging).next;

/** The same handle or address, whatever the case or `@`, `u/` or `/user/` in front. */
export const sameName = (a: unknown, b: unknown): boolean => {
  const clean = (x: unknown) =>
    text(x)
      .trim()
      .toLowerCase()
      .replace(/^\/?(?:u|user)\//, "")
      .replace(/^@/, "");
  const [x, y] = [clean(a), clean(b)];
  return !!x && x === y;
};

/**
 * A Google or MIME header value, decoded when it is RFC 2047 encoded words
 * (`=?UTF-8?B?...?=`). Gmail and the raw message may differ in encoding, never in words.
 */
export function mimeText(v: string): string {
  return v
    .replace(/\r?\n[ \t]+/g, " ")
    .replace(
      /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=\s*/g,
      (_m, cs: string, enc: string, body: string) => {
        try {
          const bytes =
            enc.toLowerCase() === "b"
              ? Buffer.from(body, "base64")
              : Buffer.from(
                  body
                    .replace(/_/g, " ")
                    .replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) =>
                      String.fromCharCode(parseInt(h, 16)),
                    ),
                  "latin1",
                );
          return new TextDecoder(cs).decode(bytes);
        } catch {
          return body;
        }
      },
    )
    .trim();
}

/** Words without links: a site shortens a link on display (`t.co`), so only the rest compares. */
export const withoutLinks = (s: string): string =>
  s
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
