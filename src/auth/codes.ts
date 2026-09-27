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
  /** Stop polling: another source already answered (a code read after this is left for the next ask). */
  signal?: AbortSignal;
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

const isPhone = (inbox: string | undefined): boolean =>
  Boolean(inbox && !inbox.includes("@") && /^\+?[\d\s().-]{7,}$/.test(inbox));

/** Polls the inbox until a message newer than `since` with a code (and the hint, if any) arrives. */
export function messageSource(opts: MessageSourceOptions): CodeSource {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 3_000;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  // A phone reads its own number; an address the credential names is for email, not a text.
  const inboxFor = (cred: Credential) =>
    opts.kind === "sms" && opts.inbox && !isPhone(cred.codesInbox)
      ? opts.inbox
      : (cred.codesInbox ?? opts.inbox ?? (cred.username.includes("@") ? cred.username : null));
  // A code typed once is spent: a second sign-in on the same phone never takes it again.
  const spent = new Set<string>();
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
        if (req.signal?.aborted) return null;
        const messages = await opts.reader.recent(inbox, req.since);
        if (req.signal?.aborted) return null;
        const match = messages
          .filter((m) => m.at.getTime() >= req.since.getTime())
          .filter((m) => !hint || `${m.from} ${m.subject} ${m.text}`.toLowerCase().includes(hint))
          .sort((a, b) => b.at.getTime() - a.at.getTime())
          .map((m) => extractCode(`${m.subject}\n${m.text}`))
          .find((c): c is string => Boolean(c) && !spent.has(`${inbox} ${c}`));
        if (match) {
          spent.add(`${inbox} ${match}`);
          return match;
        }
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

export interface InboxLockOptions {
  dir?: string;
  /** A holder older than this is gone (a crashed sign-in); its lock is taken over. */
  staleMs?: number;
  /** How long to queue behind another sign-in before giving up. */
  waitMs?: number;
  pollMs?: number;
}

/**
 * One ask at a time per inbox, across every process on this machine. A
 * texted "G-123456" names no account: two sign-ins asking the same phone at
 * once cannot tell their codes apart, so the second waits until the first
 * has asked, read and typed. Resolves to the release.
 */
export async function inboxLock(
  inbox: string,
  o: InboxLockOptions = {},
): Promise<() => Promise<void>> {
  const { mkdir, rm, stat, writeFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const staleMs = o.staleMs ?? 5 * 60_000;
  const waitMs = o.waitMs ?? 10 * 60_000;
  const pollMs = o.pollMs ?? 1_000;
  const root = o.dir ?? join(tmpdir(), "autobrowse-code-locks");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(inbox.toLowerCase()).digest("hex").slice(0, 16);
  const path = join(root, key);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(path); // atomic: exactly one process gets it
      await writeFile(join(path, "pid"), String(process.pid));
      return () => rm(path, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? 0);
      if (age > staleMs) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error("another sign-in has held this inbox's codes for too long");
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
