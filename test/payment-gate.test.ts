import { describe, expect, it } from "vitest";
import { askLine, askOverChannel } from "../src/gates/ask.js";
import { paymentGate } from "../src/gates/payment.js";

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
  it("is a no when nobody answers by the deadline", async () => {
    expect(await channel([]).approver(ask)).toBe(false);
  });
});
