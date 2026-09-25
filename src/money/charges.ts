/**
 * Every charge, told twice and written down: a text to the phone, an email
 * to the personal inbox with the receipt page (its words and a screenshot),
 * and a line in the chained `charges.jsonl`. A charge is a spending click a
 * person said yes to; the card is whichever the wallet placed this session,
 * else the one the merchant keeps.
 *
 * One channel failing never hides the charge: each is tried, the ledger
 * line records which reached William.
 */
import { type Amount, amountLine } from "../gates/spend.js";

export interface Charge {
  at: string;
  site: string;
  host: string;
  /** The receipt page, no query string. */
  url: string;
  /** What was pressed ("press "Buy $20 of credits", which spends"). */
  what: string;
  amount?: Amount;
  /** `describeCard`, or the merchant's own saved card. */
  card: string;
  recurring: boolean;
}

export interface Receipt {
  /** The receipt page's words, already masked and capped. */
  text: string;
  png?: Buffer;
}

export interface Mail {
  subject: string;
  text: string;
  attachments: { name: string; type: string; data: Buffer }[];
}

export interface ChargeDeps {
  ledger: { append(row: Charge & { told: string[] }): Promise<unknown> };
  /** A text to the phone. */
  text?: (line: string) => Promise<void>;
  /** An email to the personal inbox. */
  email?: (mail: Mail) => Promise<void>;
}

const money = (c: Charge) => (c.amount ? amountLine(c.amount) : "amount not shown");

export function chargeMail(c: Charge, r: Receipt): Mail {
  const lines = [
    `Charged: ${money(c)}${c.recurring ? " (recurring)" : ""}`,
    `Where: ${c.host} (${c.site})`,
    `Card: ${c.card}`,
    `When: ${c.at}`,
    `What was pressed: ${c.what}`,
    `Receipt page: ${c.url}`,
    "",
    "Receipt page text:",
    r.text || "(the page had no text)",
  ];
  return {
    subject: `Charge: ${money(c)} at ${c.host}`,
    text: lines.join("\n"),
    attachments: r.png
      ? [{ name: `receipt-${c.at.slice(0, 10)}.png`, type: "image/png", data: r.png }]
      : [],
  };
}

export async function reportCharge(deps: ChargeDeps, c: Charge, r: Receipt): Promise<string[]> {
  const told: string[] = [];
  const line = `autobrowse charged ${money(c)} at ${c.host} on ${c.card}${c.recurring ? " (recurring)" : ""}. Receipt emailed.`;
  await Promise.all([
    deps.text?.(line).then(
      () => void told.push("text"),
      () => undefined,
    ),
    deps.email?.(chargeMail(c, r)).then(
      () => void told.push("email"),
      () => undefined,
    ),
  ]);
  await deps.ledger.append({ ...c, told: told.sort() });
  return told;
}
