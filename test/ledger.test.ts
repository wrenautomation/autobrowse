import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileAudit } from "../src/auth/guard.js";
import { ledgerSince, ledgerSummary } from "../src/auth/ledger.js";
import { memorySpendLedger } from "../src/gates/spend.js";

describe("ledger summary", () => {
  it("reads both ledgers from a time and says what happened, never a value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ledger-"));
    const audit = fileAudit(join(dir, "audit.jsonl"));
    const spend = memorySpendLedger();
    const use = { credential: "google", field: "password" as const, site: "google", by: "login" };
    await audit.record({
      ...use,
      at: "2026-09-22T08:00:00.000Z",
      url: "https://accounts.google.com/x?token=abc",
      allowed: true,
    });
    await audit.record({
      ...use,
      at: "2026-09-22T09:10:00.000Z",
      url: "https://evil.example/p",
      by: "agent",
      allowed: false,
    });
    await spend.record({
      at: "2026-09-22T09:20:00.000Z",
      site: "meta",
      url: "https://graph.facebook.com",
      what: "adset ACTIVE",
      amount: { value: 20, currency: "USD", per: "day" },
      decided: "person",
      allowed: true,
    });
    await spend.record({
      at: "2026-09-22T09:30:00.000Z",
      site: "namecheap",
      url: "https://namecheap.com/cart",
      what: "Buy",
      amount: { value: 900, currency: "USD" },
      decided: "cap",
      allowed: false,
    });
    const w = await ledgerSince(audit, spend, new Date("2026-09-22T09:00:00Z"));
    expect(w.secrets).toHaveLength(1);
    expect(w.spend).toHaveLength(2);
    const lines = ledgerSummary(w);
    expect(lines[0]).toBe(
      "box ledger since 09:00Z: 1 secret use (1 refused) · 2 gate decisions, 20.00 USD allowed, 1 denied",
    );
    expect(lines.slice(1)).toEqual([
      "  REFUSED 09:10 google.password on evil.example by agent",
      "  spent  09:20 20.00 USD/day meta · adset ACTIVE (person)",
      "  denied 09:30 900.00 USD namecheap · Buy (cap)",
    ]);
    expect(lines.join("\n")).not.toContain("abc");
    expect(ledgerSummary({ since: w.since, secrets: [], spend: [] })).toEqual([]);
  });
});
