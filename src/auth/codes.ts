/**
 * Second factors as code: a TOTP from the stored seed, or a one-time code
 * read out of an inbox we control (email now, SMS through the same shape).
 * A login asks `codes.get(...)` and gets a string or null; it never sees
 * how the code was obtained.
 */
import type { Credential } from "credvault";
import { totp, totpRemainingMs } from "credvault";

export type CodeKind = "totp" | "email" | "sms";

export interface CodeRequest {
  site: string;
  kind: CodeKind;
  /** Codes that arrived before this moment are stale (an earlier attempt's). */
  since: Date;
  /** Something the message would contain, to pick the right one: "Cloudflare", "verification". */
  hint?: string;
}

export interface CodeSource {
  get(req: CodeRequest, cred: Credential): Promise<string | null>;
  /** Could this source answer for that kind and credential? Lets a sign-in pick its second step before asking. */
  offers(kind: CodeKind, cred: Credential): boolean;
  /** Where the code would land (a number, an address), so a page that lists several can be matched to it. */
  inbox(kind: CodeKind, cred: Credential): string | null;
}

export interface Message {
  from: string;
  subject: string;
  text: string;
  at: Date;
}

/** An inbox this system can read: Gmail through the API, SMS through the paired phone or Twilio. */
export interface MessageReader {
  recent(inbox: string, since: Date): Promise<Message[]>;
}

/**
 * The code in a message: a prefixed one first (`FB-12345`, `G-123456`), then
 * 4–8 digits next to the word "code" (Facebook's are 5), then any 6–8 digits.
 * A bare 4–5 digit number far from "code" is a year or a zip, not a code.
 */
export function extractCode(text: string): string | null {
  const near =
    text.match(/\b[A-Z]{1,4}-(\d{4,8})\b/) ??
    text.match(/code[^0-9]{0,40}?\b(\d{4,8})\b/i) ??
    text.match(/\b(\d{4,8})\b[^0-9]{0,40}?code/i);
  if (near?.[1]) return near[1];
  const any = text.match(/\b(\d{6,8})\b/);
  return any?.[1] ?? null;
}

export interface TotpSourceOptions {
  now?: () => number;
  /** A code with fewer ms left than this waits for the next one, so it is not stale by the time it lands. */
  minRemainingMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function totpSource(opts: TotpSourceOptions = {}): CodeSource {
  const now = opts.now ?? Date.now;
  const minLeft = opts.minRemainingMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return {
    offers: (kind, cred) => kind === "totp" && Boolean(cred.totpSecret),
    inbox: () => null,
    async get(req, cred) {
      if (req.kind !== "totp" || !cred.totpSecret) return null;
      const left = totpRemainingMs(now());
      if (left < minLeft) await sleep(left);
      return totp(cred.totpSecret, { at: now() });
    },
  };
}

export interface MessageSourceOptions {
  kind: Exclude<CodeKind, "totp">;
  reader: MessageReader;
  /** Which inbox, when the credential does not say. */
  inbox?: string;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Polls the inbox until a message newer than `since` with a code (and the hint, if any) arrives. */
export function messageSource(opts: MessageSourceOptions): CodeSource {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 3_000;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const inboxFor = (cred: Credential) =>
    cred.codesInbox ?? opts.inbox ?? (cred.username.includes("@") ? cred.username : null);
  return {
    offers: (kind, cred) => kind === opts.kind && inboxFor(cred) !== null,
    inbox: (kind, cred) => (kind === opts.kind ? inboxFor(cred) : null),
    async get(req, cred) {
      if (req.kind !== opts.kind) return null;
      const inbox = inboxFor(cred);
      if (!inbox) return null;
      const deadline = now() + timeoutMs;
      const hint = req.hint?.toLowerCase();
      for (;;) {
        const messages = await opts.reader.recent(inbox, req.since);
        const match = messages
          .filter((m) => m.at.getTime() >= req.since.getTime())
          .filter((m) => !hint || `${m.from} ${m.subject} ${m.text}`.toLowerCase().includes(hint))
          .sort((a, b) => b.at.getTime() - a.at.getTime())
          .map((m) => extractCode(`${m.subject}\n${m.text}`))
          .find((c): c is string => Boolean(c));
        if (match) return match;
        if (now() >= deadline) return null;
        await sleep(pollMs);
      }
    },
  };
}

/** First source with an answer wins. */
export function codeSources(...sources: CodeSource[]): CodeSource {
  return {
    offers: (kind, cred) => sources.some((s) => s.offers(kind, cred)),
    inbox: (kind, cred) => sources.find((s) => s.offers(kind, cred))?.inbox(kind, cred) ?? null,
    async get(req, cred) {
      for (const s of sources) {
        const c = await s.get(req, cred);
        if (c) return c;
      }
      return null;
    },
  };
}

export const noCodes: CodeSource = {
  get: async () => null,
  offers: () => false,
  inbox: () => null,
};
