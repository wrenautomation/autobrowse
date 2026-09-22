/**
 * The two ledgers (where secrets went, what the payment gate decided) read
 * together over a window, and the one-paragraph summary a person gets when
 * the box stops itself: what happened while it was up, never a value.
 */
import type { SecretAudit, SecretUse } from "credvault";
import { type Amount, amountLine, type SpendLedger, type SpendRecord } from "../gates/spend.js";

export interface LedgerWindow {
  since: string;
  secrets: SecretUse[];
  spend: SpendRecord[];
}

const SCAN = 5_000;

/** Both ledgers from `since` (ISO) on, oldest first. */
export async function ledgerSince(
  audit: SecretAudit,
  spend: SpendLedger,
  since: Date,
): Promise<LedgerWindow> {
  const iso = since.toISOString();
  const [uses, decisions] = await Promise.all([audit.recent(SCAN), spend.recent(SCAN)]);
  return {
    since: iso,
    secrets: uses.filter((u) => u.at >= iso),
    spend: decisions.filter((d) => d.at >= iso),
  };
}

const sum = (rows: readonly { amount: Amount | null }[]): Amount | null => {
  const money = rows.map((r) => r.amount).filter((a): a is Amount => a !== null);
  if (money.length === 0) return null;
  const currency = money[0]?.currency ?? "";
  return { value: money.reduce((t, a) => t + a.value, 0), currency };
};

const clock = (iso: string) => iso.slice(11, 16);
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Lines for the channel: a count line, then every refused secret use and
 * every gate decision (the allowed ones by amount, the denied by name).
 * Empty when nothing happened: the caller sends nothing.
 */
export function ledgerSummary(w: LedgerWindow): string[] {
  if (w.secrets.length === 0 && w.spend.length === 0) return [];
  const refused = w.secrets.filter((u) => !u.allowed);
  const allowed = w.spend.filter((d) => d.allowed);
  const denied = w.spend.filter((d) => !d.allowed);
  const total = sum(allowed);
  const head = [
    `${w.secrets.length} secret use${w.secrets.length === 1 ? "" : "s"}` +
      (refused.length ? ` (${refused.length} refused)` : ""),
    w.spend.length
      ? `${w.spend.length} gate decision${w.spend.length === 1 ? "" : "s"}` +
        (total ? `, ${amountLine(total)} allowed` : "") +
        (denied.length ? `, ${denied.length} denied` : "")
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [`box ledger since ${clock(w.since)}Z: ${head}`];
  for (const u of refused)
    lines.push(`  REFUSED ${clock(u.at)} ${u.credential}.${u.field} on ${host(u.url)} by ${u.by}`);
  for (const d of w.spend)
    lines.push(
      `  ${d.allowed ? "spent " : "denied"} ${clock(d.at)} ${d.amount ? amountLine(d.amount) : "?"} ${d.site} · ${d.what} (${d.decided})`,
    );
  return lines;
}
