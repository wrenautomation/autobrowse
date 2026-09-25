import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { HttpClient } from "../src/clients/http.js";
import { fakeLlm } from "../src/llm/fake.js";
import { openaiLlm } from "../src/llm/openai.js";
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

describe("openaiLlm", () => {
  it("learns the model's output cap from its 400 and asks within it from then on", async () => {
    const asked: number[] = [];
    const http = {
      json: async (_url: string, req: { body: { max_tokens: number } }) => {
        asked.push(req.body.max_tokens);
        return req.body.max_tokens > 8192
          ? {
              status: 400,
              ok: false,
              body: {
                error: {
                  message:
                    "max tokens must be less than or equal to 8192, the maximum output length for this model - received 20000.",
                },
              },
            }
          : {
              status: 200,
              ok: true,
              body: { model: "m", choices: [{ message: { content: "hi" } }] },
            };
      },
    } as unknown as HttpClient;
    const llm = openaiLlm({ apiKey: "k", model: "m", http });
    expect((await llm.complete({ system: "s", prompt: "p", maxTokens: 20_000 })).text).toBe("hi");
    await llm.complete({ system: "s", prompt: "p", maxTokens: 20_000 });
    expect(asked).toEqual([20_000, 8192, 8192]);
  });
});
