import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askLine, askOverChannel } from "../src/gates/ask.js";
import {
  activates,
  amountNear,
  chargesNow,
  PaymentFlowYes,
  paymentFlowOf,
  paymentGate,
  scriptActs,
  totalIn,
} from "../src/gates/payment.js";

describe("paymentGate", () => {
  it("gates billing fields and spending buttons, nothing else", () => {
    expect(paymentGate("fill", { role: "textbox", name: "Card number" })).toMatch(/billing field/);
    expect(paymentGate("fill", { placeholder: "CVC" })).toMatch(/billing field/);
    expect(paymentGate("fill", { id: "billing_address_line1" })).toMatch(/billing field/);
    expect(paymentGate("select", { name: "Payment method" })).toBeNull(); // choosing is free; the card field is not
    expect(paymentGate("fill", { name: "Business tax ID" })).toMatch(/billing field/);
    expect(paymentGate("click", { role: "button", name: "Buy $20 of credits" })).toMatch(/spends/);
    expect(paymentGate("click", { role: "button", name: "Subscribe" })).toMatch(/spends/);
    expect(paymentGate("click", { role: "button", name: "Add funds" })).toMatch(/spends/);
    expect(paymentGate("click", { role: "button", name: "Start free trial" })).toMatch(/spends/);
    expect(paymentGate("click", { role: "button", name: "Create key" })).toBeNull();
    expect(paymentGate("click", { role: "link", name: "Upgrade" })).toBeNull(); // a page, not a charge
    expect(paymentGate("fill", { role: "textbox", name: "Name" })).toBeNull();
    expect(paymentGate("fill", { role: "textbox", name: "Project name" })).toBeNull();
  });

  it("gates a plan upgrade's confirm, not the link to plans", () => {
    expect(paymentGate("click", { role: "button", name: "Confirm upgrade" })).toMatch(/spends/);
    expect(paymentGate("click", { role: "button", name: "Upgrade plan" })).toMatch(/spends/);
    expect(chargesNow({ role: "button", name: "Upgrade now" })).toBe(true);
    expect(paymentGate("click", { role: "link", name: "Upgrade" })).toBeNull();
  });

  it("knows the other ways a button gets pressed", () => {
    for (const k of ["Enter", "NumpadEnter", "Space", " ", "Shift+Enter"])
      expect(activates(k)).toBe(true);
    for (const k of ["Tab", "Escape", "ArrowDown", "a"]) expect(activates(k)).toBe(false);
    expect(scriptActs("(el) => el.click()")).toBe(true);
    expect(scriptActs("document.querySelector('form').requestSubmit()")).toBe(true);
    expect(scriptActs("el.dispatchEvent(new MouseEvent('click'))")).toBe(true);
    expect(scriptActs("el.dispatchEvent(new Event('submit'))")).toBe(true);
    expect(scriptActs("i.dispatchEvent(new Event('input', {bubbles: true}))")).toBe(false);
    expect(scriptActs("document.title")).toBe(false);
  });

  it("a selector counts only when the element says nothing", () => {
    expect(paymentGate("click", { css: "#subscribe button", text: "Get new posts" })).toBeNull();
    expect(paymentGate("click", { css: "#subscribe button", text: "Subscribe" })).toMatch(/spends/);
    expect(paymentGate("click", { css: "#checkout-pay" })).toMatch(/spends/);
  });

  it("leaving a checkout never spends: exit, cancel, back, close", () => {
    expect(paymentGate("click", { role: "button", name: "Exit checkout" })).toBeNull();
    expect(paymentGate("click", { role: "button", name: "Cancel checkout" })).toBeNull();
    expect(paymentGate("click", { role: "button", name: "Cancel order" })).toBeNull();
    expect(paymentGate("click", { role: "link", name: "Back to checkout" })).toBeNull();
    expect(
      paymentGate("click", { role: "button", name: "Go back to cart and checkout" }),
    ).toBeNull();
    expect(paymentGate("click", { role: "button", name: "Close checkout" })).toBeNull();
    expect(paymentGate("click", { css: "#x", text: "Leave checkout" })).toBeNull();
    // A leaving word with a charge after it still asks.
    expect(paymentGate("click", { role: "button", name: "Close and pay" })).toMatch(/spends/);
    expect(paymentGate("click", { role: "button", name: "Checkout" })).toMatch(/spends/);
  });

  it("gates the final order button; only a charging click is a charge", () => {
    expect(paymentGate("click", { css: "#btn", text: "Complete Order" })).toMatch(/spends/);
    expect(chargesNow({ text: "Complete Order" })).toBe(true);
    expect(chargesNow({ role: "button", name: "Pay now" })).toBe(true);
    expect(chargesNow({ role: "button", name: "Checkout" })).toBe(false);
    expect(chargesNow({ role: "button", name: "Add payment method" })).toBe(false);
    expect(chargesNow({ role: "button", name: "Start free trial" })).toBe(false);
  });
});

describe("amount from the page", () => {
  it("takes the last total line, never a subtotal, null without one", () => {
    const cart = [
      "Domain registration  $12.98",
      "Subtotal $12.98",
      "Tax $1.02",
      "Order total $14.00",
      "Pay now",
    ].join("\n");
    expect(totalIn(cart)).toEqual({ value: 14, currency: "USD" });
    expect(totalIn("Subtotal $12.98\nPay now")).toBeNull();
    expect(totalIn("Amount due today: €30\nTotal $99 later")).toEqual({
      value: 99,
      currency: "USD",
    });
    expect(totalIn("total items: 3")).toBeNull();
  });

  it("reads the block around the button and survives an evaluate that fails", async () => {
    const el = { evaluate: async <R>() => "Subtotal $5\nTotal $6.50\nBuy" as R };
    expect(await amountNear(el)).toEqual({ value: 6.5, currency: "USD" });
    const dead = {
      evaluate: async <R>(): Promise<R> => {
        throw new Error("detached");
      },
    };
    expect(await amountNear(dead)).toBeNull();
    expect(await amountNear({ evaluate: async <R>() => "" as R })).toBeNull();
  });
});

describe("askOverChannel", () => {
  const ask = { what: 'press "Buy", which spends', url: "https://x.test/billing", site: "x" };
  const at = (s: number) => new Date(1_000_000 + s * 1000);
  function channel(replies: Array<{ s: number; text: string }>) {
    const notes: string[] = [];
    let t = 0;
    const approver = askOverChannel({
      note: async (text) => {
        notes.push(text);
      },
      reader: {
        recent: async (_inbox, since) =>
          replies
            .filter((r) => at(r.s) >= since)
            .map((r) => ({ from: "+1", subject: "", text: r.text, at: at(r.s) })),
      },
      inbox: "+1",
      now: () => at(t).getTime(),
      sleep: async () => {
        t += 5;
      },
      timeoutMs: 30_000,
      pollMs: 5_000,
    });
    return { approver, notes };
  }
  it("says what and where, then takes the first yes or no after the question", async () => {
    const { approver, notes } = channel([
      { s: -10, text: "yes" }, // before the question: not an answer
      { s: 5, text: "what is this" },
      { s: 10, text: "Yes go" },
    ]);
    expect(await approver(ask)).toBe(true);
    expect(notes).toEqual([askLine(ask)]);
    expect(notes[0]).toMatch(
      /wants to press "Buy", which spends at https:\/\/x.test\/billing\. Reply yes or no/,
    );
    expect(await channel([{ s: 5, text: "no" }]).approver(ask)).toBe(false);
  });
  it("is no answer, not a no, when nobody replies by the deadline", async () => {
    expect(await channel([]).approver(ask)).toBeNull();
  });
});

describe("one yes per payment flow", () => {
  it("a site's subdomains are one flow; country-code second levels kept", () => {
    expect(paymentFlowOf("https://www.racknerd.com/kvm-vps")).toBe("racknerd.com");
    expect(paymentFlowOf("https://my.racknerd.com/cart.php?a=checkout")).toBe("racknerd.com");
    expect(paymentFlowOf("https://shop.example.co.uk/pay")).toBe("example.co.uk");
    expect(paymentFlowOf("http://127.0.0.1:9000/pay")).toBe("127.0.0.1");
    expect(paymentFlowOf("data:text/html,x")).toBe("data:text/html,x");
  });

  it("two stores on one shared host are two flows: a yes on one never covers the other", () => {
    expect(paymentFlowOf("https://alpha.myshopify.com/checkout")).toBe("alpha.myshopify.com");
    expect(paymentFlowOf("https://beta.myshopify.com/checkout")).toBe("beta.myshopify.com");
    expect(paymentFlowOf("https://shop.example.com.au/pay")).toBe("example.com.au");
  });

  it("a yes outlives the session that heard it, and runs out", () => {
    const file = join(mkdtempSync(join(tmpdir(), "flows-")), "payment-flows.json");
    let t = 1_000;
    new PaymentFlowYes(file, () => t).grant("racknerd.com", 60_000);
    const restarted = new PaymentFlowYes(file, () => t);
    expect(restarted.covers("racknerd.com")).toBe(true);
    expect(restarted.covers("example.com")).toBe(false);
    t += 60_001;
    expect(restarted.covers("racknerd.com")).toBe(false);
  });

  it("no file is no yes", () =>
    expect(new PaymentFlowYes("/nonexistent/dir/flows.json").covers("racknerd.com")).toBe(false));
});
