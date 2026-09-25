/**
 * Every charge, told twice and written down: a text to the phone, an email
 * to the personal inbox with the receipt page (its words and a screenshot),
 * and a line in the chained `charges.jsonl`. A charge is a spending click a
 * person said yes to; the card is whichever the wallet placed this session,
 * else the one the merchant keeps.
 *
 * The page the click landed on decides the word: "Charge" when it reads as
 * paid, "Declined" when it reads as refused, "Check" when it reads as
 * neither or both. After a charge (not a decline) the merchant's own emailed
 * invoice is watched for in the account's inbox and forwarded whole.
 *
 * One channel failing never hides the charge: each is tried, the ledger
 * line records which reached William.
 */
import { type Amount, amountLine } from "../gates/spend.js";

export type Outcome = "charged" | "declined" | "unclear";

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
  /** What the landing page says happened (`receiptOutcome`). */
  outcome: Outcome;
}

export interface Receipt {
  /** The receipt page's words, already masked and capped. */
  text: string;
  png?: Buffer;
}

/** The merchant's own email, whole. */
export interface Invoice {
  from: string;
  subject: string;
  at: Date;
  raw: Buffer;
}

export interface Mail {
  subject: string;
  text: string;
  attachments: { name: string; type: string; data: Buffer }[];
}

export type ChargeRow =
  | (Charge & { told: string[] })
  | { at: string; invoiceFor: string; host: string; subject: string; told: string[] };

export interface ChargeDeps {
  ledger: { append(row: ChargeRow): Promise<unknown> };
  /** A text to the phone. */
  text?: (line: string) => Promise<void>;
  /** An email to the personal inbox. */
  email?: (mail: Mail) => Promise<void>;
  /** The merchant's invoice that arrived after `since`, or null (not yet, or no inbox to read). */
  invoice?: (c: Charge, since: Date) => Promise<Invoice | null>;
  /** Waits between invoice looks; tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
}

const DECLINED =
  /\b(declined|payment (has )?failed|transaction failed|insufficient funds|(was|could) not (be )?(processed|approved|completed|charged|authori[sz]ed)|unable to (process|charge|complete)|try (another|a different) (card|payment)|card (was )?(rejected|refused)|payment (was )?unsuccessful|do not honou?r)\b/i;
const CHARGED =
  /\b(thank(s| you) for (your )?(order|purchase|payment|subscribing)|order (is )?(confirmed|complete|placed|received)|order (number|#|no\.?)|payment (successful|received|complete|confirmed|accepted)|you('ve| have) been charged|(successfully|has been) (paid|charged|purchased|subscribed)|transaction (approved|complete)|receipt (number|#)|invoice (number|#)|purchase (complete|confirmed))\b/i;

/** A page still asking for money: the click only led to the next step (RackNerd's "Complete Order" lands on an unpaid invoice). */
const UNPAID = /\b(unpaid|balance due|amount due|payment due)\b/i;
const STILL_ASKING = /\b(enter (new )?card|card number|submit payment|pay now)\b/i;

/** Not a charge yet: the page says unpaid, or reads as neither paid nor refused and still asks to pay. */
export function stillAsking(text: string): boolean {
  return UNPAID.test(text) || (receiptOutcome(text) === "unclear" && STILL_ASKING.test(text));
}

/** What the landing page says: one side only, else unclear. */
export function receiptOutcome(text: string): Outcome {
  const no = DECLINED.test(text);
  const yes = CHARGED.test(text);
  return yes === no ? "unclear" : yes ? "charged" : "declined";
}

const money = (c: Charge) => (c.amount ? amountLine(c.amount) : "amount not shown");
const WORD: Record<Outcome, string> = {
  charged: "Charge",
  declined: "Declined",
  unclear: "Check",
};
const AFTER: Record<Outcome, string> = {
  charged: "",
  declined: " (not charged)",
  unclear: " (the page did not say paid or declined)",
};

export function chargeMail(c: Charge, r: Receipt): Mail {
  const lines = [
    `${c.outcome === "declined" ? "Declined" : c.outcome === "charged" ? "Charged" : "Maybe charged"}: ${money(c)}${c.recurring ? " (recurring)" : ""}`,
    `Where: ${c.host} (${c.site})`,
    `Card: ${c.card}`,
    `When: ${c.at}`,
    `What was pressed: ${c.what}`,
    `Receipt page: ${c.url}`,
    ...(c.outcome === "declined" ? [] : ["The merchant's own invoice follows when it arrives."]),
    "",
    "Receipt page text:",
    r.text || "(the page had no text)",
  ];
  return {
    subject: `${WORD[c.outcome]}: ${money(c)} at ${c.host}${AFTER[c.outcome]}`,
    text: lines.join("\n"),
    attachments: r.png
      ? [{ name: `receipt-${c.at.slice(0, 10)}.png`, type: "image/png", data: r.png }]
      : [],
  };
}

export function invoiceMail(c: Charge, inv: Invoice): Mail {
  return {
    subject: `Invoice: ${c.host}: ${inv.subject || "(no subject)"}`,
    text: [
      `The merchant's email for the ${money(c)} charge at ${c.host} (${c.at}), attached whole.`,
      `From: ${inv.from}`,
      `Received: ${inv.at.toISOString()}`,
    ].join("\n"),
    attachments: [{ name: "invoice.eml", type: "message/rfc822", data: inv.raw }],
  };
}

const INVOICE_EVERY_MS = 30_000;
const INVOICE_FOR_MS = 15 * 60_000;

/**
 * Tell the charge now; after a charge that went through, watch for the
 * invoice in the background (the returned `invoice` settles when it is
 * forwarded or the watch ends). A process that exits first loses only the
 * forward: the charge was already told and written down.
 */
export async function reportCharge(
  deps: ChargeDeps,
  c: Charge,
  r: Receipt,
  o: { everyMs?: number; forMs?: number } = {},
): Promise<{ told: string[]; invoice: Promise<boolean> }> {
  const told: string[] = [];
  const line = `autobrowse: ${WORD[c.outcome].toLowerCase()} ${money(c)} at ${c.host} on ${c.card}${c.recurring ? " (recurring)" : ""}${AFTER[c.outcome]}. Receipt emailed.`;
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
  const invoice =
    c.outcome === "declined" || !deps.invoice || !deps.email
      ? Promise.resolve(false)
      : forwardInvoice(deps, c, o).catch(() => false);
  return { told, invoice };
}

async function forwardInvoice(
  deps: ChargeDeps,
  c: Charge,
  o: { everyMs?: number; forMs?: number },
): Promise<boolean> {
  const every = o.everyMs ?? INVOICE_EVERY_MS;
  const tries = Math.max(1, Math.ceil((o.forMs ?? INVOICE_FOR_MS) / every));
  const sleep = deps.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms).unref()));
  // A minute of slack: the merchant's clock and ours, and a mail sent as the page loaded.
  const since = new Date(Date.parse(c.at) - 60_000);
  for (let i = 0; i < tries; i++) {
    await sleep(every);
    const inv = await deps.invoice?.(c, since).catch(() => null);
    if (!inv) continue;
    const told: string[] = [];
    await deps.email?.(invoiceMail(c, inv)).then(
      () => void told.push("email"),
      () => undefined,
    );
    await deps.ledger.append({
      at: new Date().toISOString(),
      invoiceFor: c.at,
      host: c.host,
      subject: inv.subject,
      told,
    });
    return told.length > 0;
  }
  return false;
}
