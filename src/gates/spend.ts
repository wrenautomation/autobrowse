/**
 * What the payment gate may say yes to on its own, and what it must refuse
 * before anyone is asked. The person still answers everything in between.
 * Amounts come from the element that spends ("Buy $20 of credits"); a
 * button with no amount on it is always a question. Every decision is one
 * line in the spend ledger, next to the secret audit.
 */
import { chainedFile } from "credvault";
import type { Approval, Approver } from "./payment.js";

export interface Amount {
  value: number;
  /** ISO code when known (`USD`), else the symbol as seen; "" when the page did not say. */
  currency: string;
  /** A recurring amount: `day`, `month`. */
  per?: string;
}

const SYMBOLS: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };
const AMOUNT =
  /(?:(US|CA|AU|NZ)?\$|€|£|¥)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)|(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s?(USD|EUR|GBP|CAD|AUD|JPY)\b/;

/** The first money amount in a text, or null. "Buy $20 of credits" → 20 USD. */
export function amountIn(text: string): Amount | null {
  const m = AMOUNT.exec(text);
  if (!m) return null;
  if (m[2] !== undefined) {
    const symbol = m[0].trim()[0] ?? "$";
    const prefix = m[1];
    const currency =
      prefix && symbol === "U" ? "USD" : prefix ? `${prefix}D` : (SYMBOLS[symbol] ?? symbol);
    return { value: Number(m[2].replace(/,/g, "")), currency };
  }
  return { value: Number((m[3] ?? "0").replace(/,/g, "")), currency: m[4] ?? "" };
}

export const amountLine = (a: Amount): string =>
  `${a.value.toFixed(2)}${a.currency ? ` ${a.currency}` : ""}${a.per ? `/${a.per}` : ""}`;

export interface SpendPolicy {
  /** Sites the gate may answer yes for itself (never any other). */
  allow: readonly string[];
  /** One purchase at or under this, on an allowed site, is a yes without asking. 0: never. */
  autoYesUnder: number;
  /** Auto-yes stops once today's total (auto + person) would pass this. 0: no auto-yes. */
  dailyCap: number;
  /** Over this, refused outright, nobody asked. null: no ceiling. */
  hardCap: number | null;
}

export const NO_AUTO_SPEND: SpendPolicy = {
  allow: [],
  autoYesUnder: 0,
  dailyCap: 0,
  hardCap: null,
};

export type Decided = "auto" | "person" | "cap" | "denied" | "unanswered";

export interface SpendRecord {
  at: string;
  site: string;
  url: string;
  what: string;
  amount: Amount | null;
  /** Who decided: the policy (auto, cap) or the person (person, denied). */
  decided: Decided;
  allowed: boolean;
}

export interface SpendLedger {
  record(r: SpendRecord): Promise<void>;
  /** Newest last. */
  recent(n?: number): Promise<SpendRecord[]>;
}

/** JSON lines, 0600. Same shape as the secret audit. */
export function fileSpendLedger(path: string): SpendLedger {
  const file = chainedFile<SpendRecord>(path);
  return {
    async record(r) {
      await file.append(r);
    },
    recent: (n = 50) => file.recent(n),
  };
}

export function memorySpendLedger(): SpendLedger & { records: SpendRecord[] } {
  const records: SpendRecord[] = [];
  return {
    records,
    async record(r) {
      records.push(r);
    },
    async recent(n = 50) {
      return records.slice(-n);
    },
  };
}

/** What was allowed today (UTC day of `now`), in the ledger's own units, ignoring currency. */
export async function spentToday(ledger: SpendLedger, now: Date): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  return (await ledger.recent(1000))
    .filter((r) => r.allowed && r.amount && r.at.startsWith(day))
    .reduce((sum, r) => sum + (r.amount?.value ?? 0), 0);
}

export interface PolicedOptions {
  policy: SpendPolicy;
  ledger: SpendLedger;
  now?: () => Date;
}

/**
 * The approver behind the gate: refuses over the ceiling, says yes under the
 * small cap on an allowed site, asks the person otherwise. Everything is
 * written down either way.
 */
export function policedApprover(ask: Approver, o: PolicedOptions): Approver {
  const now = o.now ?? (() => new Date());
  return async (a: Approval) => {
    const amount = a.amount ?? null;
    const write = (decided: Decided, allowed: boolean) =>
      o.ledger.record({
        at: now().toISOString(),
        site: a.site,
        url: a.url,
        what: a.what,
        amount,
        decided,
        allowed,
      });
    if (amount && o.policy.hardCap !== null && amount.value > o.policy.hardCap) {
      await write("cap", false);
      return false;
    }
    if (
      amount &&
      o.policy.allow.includes(a.site) &&
      o.policy.autoYesUnder > 0 &&
      amount.value <= o.policy.autoYesUnder &&
      (await spentToday(o.ledger, now())) + amount.value <= o.policy.dailyCap
    ) {
      await write("auto", true);
      return true;
    }
    const yes = await ask(a);
    await write(yes ? "person" : yes === null ? "unanswered" : "denied", yes === true);
    return yes;
  };
}
