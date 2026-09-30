import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  countedLlm,
  fileLlmCalls,
  type LlmCall,
  memoryLlmCalls,
  readLlmCalls,
} from "../src/llm/ledger.js";
import type { Llm, LlmRequest } from "../src/llm/types.js";

const tmp = () => mkdtempSync(join(tmpdir(), "autobrowse-llm-ledger-"));

const call = (at: string, o: Partial<LlmCall> = {}): LlmCall => ({
  at,
  model: "fake/model",
  purpose: "agent-step",
  inputTokens: 1000,
  cachedTokens: 0,
  outputTokens: 50,
  ms: 10,
  ok: true,
  images: 0,
  promptChars: 100,
  ...o,
});

/** A clock that answers each call with the next value. */
const ticks = (...ms: number[]) => {
  let i = 0;
  return () => ms[Math.min(i++, ms.length - 1)] as number;
};

describe("fileLlmCalls", () => {
  it("writes one file per month, owner-only", () => {
    const dir = join(tmp(), "llm");
    const calls = fileLlmCalls(dir);
    calls.record(call("2026-09-30T23:59:59.000Z"));
    calls.record(call("2026-10-01T00:00:00.000Z"));
    calls.record(call("2026-10-15T00:00:00.000Z"));
    expect(readdirSync(dir).sort()).toEqual(["llm-2026-09.jsonl", "llm-2026-10.jsonl"]);
    expect(statSync(join(dir, "llm-2026-10.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("never throws when the folder cannot be made", () => {
    const root = tmp();
    const file = join(root, "a-file");
    writeFileSync(file, "x");
    const calls = fileLlmCalls(join(file, "llm"));
    expect(() => calls.record(call("2026-09-30T00:00:00.000Z"))).not.toThrow();
  });
});

describe("readLlmCalls", () => {
  it("is empty for a missing folder", () => {
    expect(readLlmCalls(join(tmp(), "nope"), "2026-09-01T00:00:00.000Z")).toEqual([]);
  });

  it("reads calls since a time from the months that can hold them, oldest first", () => {
    const dir = tmp();
    const calls = fileLlmCalls(dir);
    calls.record(call("2026-08-31T23:00:00.000Z", { purpose: "old" }));
    calls.record(call("2026-09-01T00:00:00.000Z", { purpose: "before" }));
    calls.record(call("2026-09-20T00:00:00.000Z", { purpose: "at" }));
    calls.record(call("2026-10-01T00:00:00.000Z", { purpose: "after" }));
    const got = readLlmCalls(dir, "2026-09-20T00:00:00.000Z");
    expect(got.map((c) => c.purpose)).toEqual(["at", "after"]);
  });

  it("skips torn lines and files that are not month files", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "llm-2026-09.jsonl"),
      `${JSON.stringify(call("2026-09-02T00:00:00.000Z"))}\n{"at":"2026-09-03\n\n`,
    );
    writeFileSync(join(dir, "llm-2026-9.jsonl"), JSON.stringify(call("2026-09-04T00:00:00.000Z")));
    writeFileSync(join(dir, "other.jsonl"), JSON.stringify(call("2026-09-05T00:00:00.000Z")));
    const got = readLlmCalls(dir, "2026-09-01T00:00:00.000Z");
    expect(got.map((c) => c.at)).toEqual(["2026-09-02T00:00:00.000Z"]);
  });
});

describe("countedLlm", () => {
  const req: LlmRequest = { system: "sys", prompt: "prompt!", purpose: "repair" };

  it("records model, purpose, tokens, time and prompt size, and returns the reply untouched", async () => {
    const reply = {
      text: "ok",
      model: "fake/model",
      usage: { inputTokens: 1200, outputTokens: 30, cachedTokens: 900 },
    };
    const llm: Llm = { id: "fake/model", complete: async () => reply };
    const rec = memoryLlmCalls();
    const counted = countedLlm(
      llm,
      rec,
      ticks(Date.parse("2026-09-30T10:00:00.000Z"), Date.parse("2026-09-30T10:00:00.250Z")),
    );
    expect(counted.id).toBe("fake/model");
    const got = await counted.complete({
      ...req,
      images: [
        { mediaType: "image/png", data: "AAAA" },
        { mediaType: "image/jpeg", data: "BBBB" },
      ],
    });
    expect(got).toBe(reply);
    expect(rec.rows).toEqual([
      {
        at: "2026-09-30T10:00:00.000Z",
        model: "fake/model",
        purpose: "repair",
        inputTokens: 1200,
        cachedTokens: 900,
        outputTokens: 30,
        ms: 250,
        ok: true,
        images: 2,
        promptChars: 10,
      },
    ]);
  });

  it("labels a call with no purpose and counts missing cache reads as none", async () => {
    const llm: Llm = {
      id: "m",
      complete: async () => ({ text: "", model: "m", usage: { inputTokens: 5, outputTokens: 1 } }),
    };
    const rec = memoryLlmCalls();
    await countedLlm(llm, rec, ticks(0, 0)).complete({ system: "", prompt: "p" });
    expect(rec.rows[0]).toMatchObject({
      purpose: "unlabeled",
      cachedTokens: 0,
      images: 0,
      promptChars: 1,
    });
  });

  it("counts a failed call with no tokens, ok false, and still throws", async () => {
    const boom = new Error("provider down");
    const llm: Llm = {
      id: "m",
      complete: async () => {
        throw boom;
      },
    };
    const rec = memoryLlmCalls();
    await expect(countedLlm(llm, rec, ticks(1000, 1600)).complete(req)).rejects.toBe(boom);
    expect(rec.rows).toEqual([
      expect.objectContaining({
        ok: false,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        purpose: "repair",
        ms: 600,
      }),
    ]);
  });

  it("writes through fileLlmCalls to the month of the call", async () => {
    const dir = tmp();
    const llm: Llm = {
      id: "m",
      complete: async () => ({ text: "", model: "m", usage: { inputTokens: 5, outputTokens: 1 } }),
    };
    await countedLlm(
      llm,
      fileLlmCalls(dir),
      ticks(Date.parse("2026-12-31T23:59:59.900Z")),
    ).complete(req);
    expect(existsSync(join(dir, "llm-2026-12.jsonl"))).toBe(true);
    expect(readLlmCalls(dir, "2026-12-01T00:00:00.000Z")).toHaveLength(1);
  });
});
