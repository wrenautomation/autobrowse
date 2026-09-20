import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BudgetExceeded, budgetedLlm, fileLedger, memoryLedger } from "../src/llm/budget.js";
import { fakeLlm } from "../src/llm/fake.js";

const reply = { a: 1 };

describe("budgetedLlm", () => {
  it("counts every call, refuses once the day's cap is reached, and starts over the next day", async () => {
    let now = new Date("2026-09-21T10:00:00Z");
    const inner = fakeLlm([reply, reply, reply], { inputTokens: 60, outputTokens: 40 });
    const told: string[] = [];
    const llm = budgetedLlm(inner, {
      dailyTokens: 150,
      ledger: memoryLedger(),
      now: () => now,
      onExceeded: (e) => void told.push(e.message),
    });
    await llm.complete({ system: "", prompt: "1" });
    expect(llm.usedToday()).toBe(100);
    await llm.complete({ system: "", prompt: "2" }); // 100 < 150: allowed, lands at 200
    await expect(llm.complete({ system: "", prompt: "3" })).rejects.toThrow(BudgetExceeded);
    await expect(llm.complete({ system: "", prompt: "3" })).rejects.toThrow(/200 of 150 tokens/);
    expect(inner.requests).toHaveLength(2);
    expect(told).toHaveLength(1); // said once, not on every refused call
    now = new Date("2026-09-22T00:00:01Z");
    expect(llm.usedToday()).toBe(0);
    await llm.complete({ system: "", prompt: "3" });
    expect(inner.requests).toHaveLength(3);
  });

  it("shares one file between processes and treats a torn file as empty", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "budget-")), "llm-budget.json");
    const a = budgetedLlm(fakeLlm([reply], { inputTokens: 10, outputTokens: 5 }), {
      dailyTokens: 1000,
      ledger: fileLedger(path),
    });
    const b = budgetedLlm(fakeLlm([reply], { inputTokens: 1, outputTokens: 1 }), {
      dailyTokens: 1000,
      ledger: fileLedger(path),
    });
    await a.complete({ system: "", prompt: "x" });
    await b.complete({ system: "", prompt: "y" });
    expect(a.usedToday()).toBe(17);
    expect(JSON.parse(readFileSync(path, "utf8")).inputTokens).toBe(11);
    expect(fileLedger(join(path, "..", "missing.json")).read()).toBeNull();
  });
});
