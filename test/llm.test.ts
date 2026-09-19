import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeLlm } from "../src/llm/fake.js";
import { completeJson, extractJson, LlmOutputInvalid } from "../src/llm/types.js";

describe("extractJson", () => {
  it("takes a fenced or bare object", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('sure: {"a":1} done')).toEqual({ a: 1 });
    expect(() => extractJson("nope")).toThrow(/no JSON/);
  });
});

describe("completeJson", () => {
  const schema = z.object({ name: z.string() });
  it("retries once with the validation error, then gives up", async () => {
    const llm = fakeLlm([{ name: 1 }, { name: "ok" }]);
    const { value, usage } = await completeJson(llm, schema, { system: "s", prompt: "p" });
    expect(value).toEqual({ name: "ok" });
    expect(usage.inputTokens).toBe(20);
    expect(llm.requests[1]?.prompt).toMatch(/failed validation: name/);
    expect(llm.requests.every((r) => r.json)).toBe(true);

    const bad = fakeLlm(["not json", "still not"]);
    await expect(completeJson(bad, schema, { system: "s", prompt: "p" })).rejects.toBeInstanceOf(
      LlmOutputInvalid,
    );
  });
});
