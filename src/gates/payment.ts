/**
 * Money is a person's decision. Anything that fills billing details or
 * presses a button that spends is a gated act: the session asks the person
 * first (over a channel they own) and does nothing until they say yes. The
 * detection is by the element, not the site, so a checkout nobody mapped
 * still stops. False positives cost one question; a miss costs money.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { registrable } from "../auth/guard.js";
import type { Hints } from "../browser/locate.js";
import type { Amount } from "./spend.js";
import { amountIn } from "./spend.js";

/** A field that takes billing details: card, bank, tax, billing address. */
export const PAYMENT_FIELD =
  /\b(card(holder| ?number| ?name|number)?|cc[-_ ]?(number|num|exp|csc|name)|cvv|cvc|csc|expir(y|ation)|iban|bic|swift|routing|account ?number|bank|tax ?id|vat|gst|billing|cardnumber|credit ?card|debit)\b/i;

/** A button that spends or commits to spend. */
export const PAYMENT_ACTION =
  /\b(buy|pay(ment)? now|pay|purchase|subscribe|checkout|check out|place (your )?order|complete (your )?(order|purchase|payment|checkout)|submit (order|payment)|finish (order|purchase)|order now|add funds|add credits|top up|confirm (payment|purchase|order)|confirm and pay|start (free |your )?trial|add (a )?(payment method|card))\b/i;

/** The gated clicks that take money now; the rest (checkout, add a card, a trial) only lead to one. */
export const CHARGE_ACTION =
  /\b(buy|pay(ment)? now|pay|purchase|subscribe|place (your )?order|complete (your )?(order|purchase|payment|checkout)|submit (order|payment)|finish (order|purchase)|order now|add funds|add credits|top up|confirm (payment|purchase|order)|confirm and pay)\b/i;

/** Whether this click charges (a receipt follows) rather than leads to a charge. */
export function chargesNow(hints: Hints): boolean {
  return CHARGE_ACTION.test(words(hints));
}

export type GatedAct = "fill" | "select" | "click";

/** ids and test ids are snake or kebab case: split so `billing_address` reads as words. */
function words(h: Hints): string {
  return [h.name, h.placeholder, h.id, h.testId, h.text, h.css]
    .filter((s): s is string => Boolean(s))
    .join(" ")
    .replace(/[_-]+/g, " ");
}

/**
 * Why this act needs a person, or null. A fill or select into a billing
 * field; a click on a button that spends. Typing into a plain field on a
 * checkout page is not gated: the button after it is.
 */
/** The amount the element names, if any: what the gate's ask and the spend policy read. */
export function paymentAmount(hints: Hints): Amount | null {
  return amountIn(words(hints));
}

const TOTAL_LINE =
  /\b(grand |order |amount |cart )?total\b|\bamount due\b|\bdue (today|now)\b|\byou(’|')?ll pay\b/i;
const NOT_TOTAL = /\bsub-?total\b/i;

/**
 * The order total in a block of page text: the amount on the last line that
 * says "total" / "amount due" (not "subtotal"). Null when no such line has
 * one, so a button with no amount stays a question with no amount.
 */
export function totalIn(text: string): Amount | null {
  let found: Amount | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!TOTAL_LINE.test(line) || NOT_TOTAL.test(line)) continue;
    const a = amountIn(line);
    if (a) found = a;
  }
  return found;
}

/** The smallest ancestor around an element whose text names a total, capped; "" when none within 8 levels. */
const TOTAL_BLOCK = `(el) => {
  let n = el;
  for (let i = 0; i < 8 && n; i++) {
    const t = (n.innerText || "").trim();
    if (t.length > 4000) return "";
    if (/total|amount due|due (today|now)/i.test(t)) return t;
    n = n.parentElement;
  }
  return "";
}`;

/** Something with Playwright's `evaluate`: a Locator or ElementHandle. */
export interface Evaluable {
  evaluate<R>(fn: string): Promise<R>;
}

/**
 * The amount the page shows for a spending button that names none: the
 * order total nearest the button (its closest ancestor that says "total").
 * Read once, at the ask; the gate still asks when nothing is found.
 */
export async function amountNear(el: Evaluable): Promise<Amount | null> {
  const block = await el.evaluate<string>(TOTAL_BLOCK).catch(() => "");
  return block ? totalIn(block) : null;
}

export function paymentGate(act: GatedAct, hints: Hints): string | null {
  const w = words(hints);
  if ((act === "fill" || act === "select") && PAYMENT_FIELD.test(w))
    return `${act} a billing field "${hints.name ?? hints.placeholder ?? hints.id ?? w}"`;
  if (act === "click" && PAYMENT_ACTION.test(w))
    return `press "${hints.name ?? hints.text ?? w}", which spends`;
  return null;
}

/** The question, and the person's answer. */
export interface Approval {
  /** What is about to happen, in one line ("press "Buy $20 of credits", which spends"). */
  what: string;
  /** Where: the page's URL, the site profile. */
  url: string;
  site: string;
  /** The amount on the element, when it shows one ("Buy $20 of credits"). */
  amount?: Amount;
}

/**
 * Asks a person: true on an explicit yes, false on a no, null when no answer
 * came in time. Only a yes lets the act happen.
 */
export type Approver = (ask: Approval) => Promise<boolean | null>;

/** The refusal an explore command answers with: the act did not happen. */
export type GateReason = "no-approver" | "denied" | "no-answer" | "asked";

export class PaymentGate extends Error {
  readonly gate = "payment" as const;
  constructor(
    readonly what: string,
    readonly reason: GateReason,
  ) {
    super(
      reason === "no-approver"
        ? `payment step needs a person: ${what}; no channel to ask on (set PHONE_NUMBER, LINQ_* or NOTIFY_TO)`
        : reason === "denied"
          ? `payment step refused: ${what}`
          : reason === "asked"
            ? `payment step asked: ${what}; the person has been texted; to hold until they answer, send the same command to ?wait=1 (cmd.sh does), or send it again after they answer`
            : `payment step unanswered: ${what}; no reply in time, send the same command again to ask again`,
    );
  }
}

/**
 * One question per act, asked once and remembered until it is answered and
 * consumed. A caller that cannot wait (an HTTP request) asks and comes back
 * with the same act; a caller that can (the agent in process) waits on it.
 */
export class PendingApprovals {
  private readonly pending = new Map<
    string,
    { promise: Promise<boolean | null>; answer: boolean | null | undefined }
  >();
  constructor(private readonly approve: Approver) {}

  /** True to proceed; throws PaymentGate("asked") when the answer is not in yet and `wait` is off. */
  async decide(key: string, ask: Approval, wait: boolean): Promise<void> {
    let entry = this.pending.get(key);
    if (!entry) {
      const e: { promise: Promise<boolean | null>; answer: boolean | null | undefined } = {
        promise: null as never,
        answer: undefined,
      };
      e.promise = this.approve(ask)
        .catch(() => null)
        .then((a) => {
          e.answer = a;
          return a;
        });
      entry = e;
      this.pending.set(key, entry);
    }
    if (wait) await entry.promise;
    if (entry.answer === undefined) throw new PaymentGate(ask.what, "asked");
    this.pending.delete(key);
    // Silence is not a no: the next try asks again.
    if (entry.answer === null) throw new PaymentGate(ask.what, "no-answer");
    if (!entry.answer) throw new PaymentGate(ask.what, "denied");
  }
}

/**
 * The site a payment flow belongs to: the registrable domain, so `www.` and `my.`
 * on one company are one flow (a store and its billing portal), and two stores on
 * a shared host (`alpha.myshopify.com`) are two. A data: page or a desktop app is
 * its own flow.
 */
export function paymentFlowOf(url: string): string {
  const host = URL.canParse(url) ? new URL(url).hostname : "";
  if (!host) return url;
  return registrable(host);
}

/**
 * One yes per payment flow, kept on disk so it outlives the session: a restart
 * (a fresh sign-in, a crash) mid-checkout must not ask again. Each entry is the
 * flow's site and when its yes runs out.
 */
export class PaymentFlowYes {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): Record<string, number> {
    try {
      const all = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, number>;
      const t = this.now();
      return Object.fromEntries(Object.entries(all).filter(([, until]) => until > t));
    } catch {
      return {};
    }
  }

  covers(flow: string): boolean {
    return (this.read()[flow] ?? 0) > this.now();
  }

  grant(flow: string, ms: number): void {
    const all = { ...this.read(), [flow]: this.now() + ms };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
  }
}
