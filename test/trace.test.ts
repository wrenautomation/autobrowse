import { describe, expect, it } from "vitest";
import { fakeLlm } from "../src/llm/fake.js";
import {
  memorySink,
  type otlpBody,
  otlpSink,
  parseOtlpHeaders,
  tracedLlm,
  traceIdOf,
  withTrace,
} from "../src/llm/trace.js";

describe("traced llm", () => {
  it("one span per call, tagged with the session and step, never the prompt", async () => {
    const sink = memorySink();
    const llm = tracedLlm(fakeLlm(['{"ok":true}', "loose"]), sink);
    await withTrace({ session: "s1", step: 3 }, () =>
      llm.complete({ system: "sys", prompt: "secret words", json: true }),
    );
    await llm.complete({ system: "sys", prompt: "loose" });
    expect(sink.spans).toHaveLength(2);
    const [a, b] = sink.spans;
    expect(a?.traceId).toBe(traceIdOf("s1"));
    expect(a?.attributes["autobrowse.session"]).toBe("s1");
    expect(a?.attributes["autobrowse.step"]).toBe(3);
    expect(a?.attributes["llm.json"]).toBe(true);
    expect(JSON.stringify(a)).not.toContain("secret words");
    expect(b?.attributes["autobrowse.session"]).toBeUndefined();
    expect(a?.endMs).toBeGreaterThanOrEqual(a?.startMs ?? 0);
  });

  it("a failing call is a failed span and still throws", async () => {
    const sink = memorySink();
    const llm = tracedLlm(
      { id: "x", complete: async () => Promise.reject(new Error("down")) },
      sink,
    );
    await expect(llm.complete({ system: "", prompt: "p" })).rejects.toThrow("down");
    expect(sink.spans[0]?.ok).toBe(false);
    expect(sink.spans[0]?.attributes["error.type"]).toBe("Error");
  });

  it("otlp: headers parse, the body is OTLP/JSON, batches post once", async () => {
    expect(parseOtlpHeaders("Authorization=Basic%20abc, x-a=1")).toEqual({
      Authorization: "Basic abc",
      "x-a": "1",
    });
    const posts: Array<{ url: string; headers: unknown; body: unknown }> = [];
    const http = {
      json: async (url: string, req: { headers?: unknown; body?: unknown } = {}) => {
        posts.push({ url, headers: req.headers, body: req.body });
        return { status: 200, ok: true, body: null, headers: new Headers() };
      },
    };
    const sink = otlpSink({ endpoint: "https://o.example/", headers: "k=v", http, batch: 2 });
    const llm = tracedLlm(fakeLlm(["a", "b"]), sink);
    await llm.complete({ system: "", prompt: "a" });
    expect(posts).toHaveLength(0);
    await llm.complete({ system: "", prompt: "b" });
    await sink.flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("https://o.example/v1/traces");
    expect(posts[0]?.headers).toEqual({ k: "v" });
    const body = posts[0]?.body as ReturnType<typeof otlpBody> & {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>;
    };
    expect(body.resourceSpans[0]?.scopeSpans[0]?.spans).toHaveLength(2);
  });
});
