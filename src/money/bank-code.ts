/**
 * The code a card's bank texts to confirm a payment (3-D Secure). The agent
 * types it by name (`place{secret:"card.code"}`, or `card@<label>.code`), so
 * it never reads the value. It is read the way a site's texted code is: from
 * the paired phone's Messages, newest first (`phoneReader`, `extractCode`).
 *
 * It belongs to one payment, so the session hands it out only after a card
 * landed on a flow a person said yes to, within `CODE_WINDOW_MS`, and only a
 * message that arrived after the card did. Any host and frame may have it:
 * the bank's challenge is an iframe on the bank's domain.
 */
import { extractCode, type Message, type MessageReader } from "../auth/codes.js";

/** How long after a card lands the bank's code may still be placed. */
export const CODE_WINDOW_MS = 10 * 60_000;

/** `card.code` → any card; `card@main.code` → that card. Null: not the bank's code. */
export function bankCodeSecret(name: string): { label: string | null } | null {
  const m = /^card(?:@([a-z0-9-]+))?\.code$/.exec(name);
  return m ? { label: m[1] ?? null } : null;
}

/** Whether a card that landed at `landed` may still be given its bank's code at `now`. */
export function codeWindowOpen(landed: number, now: number): boolean {
  return now - landed <= CODE_WINDOW_MS;
}

/** Banks text digits (4 to 8); a letters-and-digits "code" is some other site's. */
const NUMERIC = /^\d{4,8}$/;
const numericCode = (m: Message): string | null => {
  const code = extractCode(`${m.subject}\n${m.text}`);
  return code && NUMERIC.test(code) ? code : null;
};

export interface BankCodeOptions {
  /** How long one read waits for the text to arrive. */
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Reads the newest numeric code that arrived at or after `since`. A code
 * handed out is spent: the next read takes only a text newer than it, so a
 * resend is a new code and an older one is never typed twice. Waits for the
 * text to land, then null.
 */
export function bankCodeReader(
  reader: MessageReader,
  inbox: string,
  o: BankCodeOptions = {},
): (since: Date) => Promise<string | null> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 3_000;
  const timeoutMs = o.timeoutMs ?? 90_000;
  let spentAt = -Infinity;
  return async (since) => {
    const deadline = now() + timeoutMs;
    for (;;) {
      const found = (await reader.recent(inbox, since))
        .filter((m) => m.at.getTime() >= since.getTime() && m.at.getTime() > spentAt)
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .find((m) => numericCode(m) !== null);
      if (found) {
        spentAt = found.at.getTime();
        return numericCode(found);
      }
      if (now() >= deadline) return null;
      await sleep(pollMs);
    }
  };
}
