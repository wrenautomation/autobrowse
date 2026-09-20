/**
 * Money is a person's decision. Anything that fills billing details or
 * presses a button that spends is a gated act: the session asks the person
 * first (over a channel they own) and does nothing until they say yes. The
 * detection is by the element, not the site, so a checkout nobody mapped
 * still stops. False positives cost one question; a miss costs money.
 */
import type { Hints } from "../browser/locate.js";

/** A field that takes billing details: card, bank, tax, billing address. */
export const PAYMENT_FIELD =
  /\b(card(holder| ?number| ?name|number)?|cc[-_ ]?(number|num|exp|csc|name)|cvv|cvc|csc|expir(y|ation)|iban|bic|swift|routing|account ?number|bank|tax ?id|vat|gst|billing|cardnumber|credit ?card|debit)\b/i;

/** A button that spends or commits to spend. */
export const PAYMENT_ACTION =
  /\b(buy|pay(ment)? now|pay|purchase|subscribe|checkout|check out|place (your )?order|add funds|add credits|top up|confirm (payment|purchase|order)|start (free |your )?trial|add (a )?(payment method|card))\b/i;

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
}

/** Asks a person; true only on an explicit yes. Absent → the act is refused. */
export type Approver = (ask: Approval) => Promise<boolean>;

/** The refusal an explore command answers with: the act did not happen. */
export class PaymentGate extends Error {
  readonly gate = "payment" as const;
  constructor(
    readonly what: string,
    readonly reason: "no-approver" | "denied" | "no-answer",
  ) {
    super(
      reason === "no-approver"
        ? `payment step needs a person: ${what}; no channel to ask on (set PHONE_NUMBER, LINQ_* or NOTIFY_TO)`
        : reason === "denied"
          ? `payment step refused: ${what}`
          : `payment step unanswered: ${what}`,
    );
  }
}
