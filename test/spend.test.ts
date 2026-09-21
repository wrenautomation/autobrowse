import { describe, expect, it } from "vitest";
import { askLine } from "../src/gates/ask.js";
import { paymentAmount } from "../src/gates/payment.js";
import {
  amountIn,
  memorySpendLedger,
  NO_AUTO_SPEND,
  policedApprover,
  type SpendPolicy,
} from "../src/gates/spend.js";

describe("amountIn", () => {
  it("reads the money on a button, or nothing", () => {
    expect(amountIn("Buy $20 of credits")).toEqual({ value: 20, currency: "USD" });
    expect(amountIn("Pay US$1,250.50")).toEqual({ value: 1250.5, currency: "USD" });
    expect(amountIn("Subscribe for €9.99/mo")).toEqual({ value: 9.99, currency: "EUR" });
    expect(amountIn("Confirm order 45.00 GBP")).toEqual({ value: 45, currency: "GBP" });
    expect(amountIn("Add 500 credits")).toBeNull();
    expect(amountIn("Buy now")).toBeNull();
    expect(paymentAmount({ role: "button", name: "Top up $5" })).toEqual({
      value: 5,
      currency: "USD",
    });
  });

  it("puts the amount in the ask", () => {
    expect(
      askLine({
        what: 'press "Buy"',
        url: "https://x.test/b",
        site: "x",
        amount: amountIn("$20")!,
      }),
    ).toBe(
      'autobrowse on x wants to press "Buy" (20.00 USD) at https://x.test/b. Reply yes or no.',
    );
  });
});

describe("policedApprover", () => {
  const ask = (site: string, text: string) => ({
    what: `press "${text}", which spends`,
    url: `https://${site}.test/billing`,
    site,
    ...(amountIn(text) ? { amount: amountIn(text)! } : {}),
  });
  const policy: SpendPolicy = {
    allow: ["anthropic"],
    autoYesUnder: 25,
    dailyCap: 40,
    hardCap: 500,
  };
  function setup(p = policy, answer = true) {
    const asked: string[] = [];
    const ledger = memorySpendLedger();
    let t = 0;
    const approve = policedApprover(
      async (a) => {
        asked.push(a.what);
        return answer;
      },
      { policy: p, ledger, now: () => new Date(Date.UTC(2026, 8, 22, 12, t++)) },
    );
    return { approve, asked, ledger };
  }

  it("says yes alone under the cap on an allowed site, until the day's cap", async () => {
    const { approve, asked, ledger } = setup();
    expect(await approve(ask("anthropic", "Buy $20 of credits"))).toBe(true);
    expect(asked).toEqual([]);
    expect(await approve(ask("anthropic", "Buy $20 of credits"))).toBe(true); // 40 = cap
    expect(await approve(ask("anthropic", "Buy $5 of credits"))).toBe(true); // asked: 45 > 40
    expect(asked).toEqual(['press "Buy $5 of credits", which spends']);
    expect(ledger.records.map((r) => r.decided)).toEqual(["auto", "auto", "person"]);
  });

  it("asks for other sites, unknown amounts, and anything over the auto line", async () => {
    const { approve, asked } = setup();
    await approve(ask("openai", "Buy $5 of credits"));
    await approve(ask("anthropic", "Buy now"));
    await approve(ask("anthropic", "Buy $30 of credits"));
    expect(asked).toHaveLength(3);
  });

  it("refuses over the ceiling without asking, and writes the person's no down", async () => {
    const { approve, asked, ledger } = setup(policy, false);
    expect(await approve(ask("anthropic", "Pay $1,000"))).toBe(false);
    expect(asked).toEqual([]);
    expect(await approve(ask("anthropic", "Pay $100"))).toBe(false);
    expect(asked).toHaveLength(1);
    expect(ledger.records.map((r) => [r.decided, r.allowed])).toEqual([
      ["cap", false],
      ["denied", false],
    ]);
  });

  it("with no policy every ask goes to the person", async () => {
    const { approve, asked } = setup(NO_AUTO_SPEND);
    expect(await approve(ask("anthropic", "Buy $1 of credits"))).toBe(true);
    expect(asked).toHaveLength(1);
  });
});
