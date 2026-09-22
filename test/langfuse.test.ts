import { memoryEnvStore } from "credvault";
import { describe, expect, it } from "vitest";
import {
  checkTracing,
  LANGFUSE_BASE_URL,
  LANGFUSE_PUBLIC_KEY,
  LANGFUSE_SECRET_KEY,
  OTLP_ENDPOINT,
  OTLP_HEADERS,
  otlpHeaderValue,
  recentSpans,
  wireTracing,
} from "../src/chores/langfuse.js";

const keys = { [LANGFUSE_PUBLIC_KEY]: "pk-lf-1", [LANGFUSE_SECRET_KEY]: "sk-lf-2" };

describe("langfuse wiring", () => {
  it("derives the three OTEL names from the two keys", async () => {
    const env = memoryEnvStore({ ...keys });
    const r = await wireTracing(env, { serviceName: "wren" });
    expect(r.endpoint).toBe("https://cloud.langfuse.com/api/public/otel");
    expect(await env.get(OTLP_ENDPOINT)).toBe(r.endpoint);
    expect(await env.get(OTLP_HEADERS)).toBe(otlpHeaderValue("pk-lf-1", "sk-lf-2"));
    expect(r.wrote).toContain(LANGFUSE_BASE_URL);
  });

  it("says what to run when the keys are not there yet", async () => {
    await expect(wireTracing(memoryEnvStore())).rejects.toThrow(/site setup langfuse/);
  });

  it("checks by posting an empty batch through the wired door", async () => {
    const env = memoryEnvStore({ ...keys });
    await wireTracing(env);
    let seen = "";
    const r = await checkTracing(env, async (url, init) => {
      seen = `${url} ${init.headers.Authorization}`;
      return { status: 207 };
    });
    expect(r.ok).toBe(true);
    expect(seen).toBe(
      `https://cloud.langfuse.com/api/public/otel/v1/traces Basic ${Buffer.from("pk-lf-1:sk-lf-2").toString("base64")}`,
    );
  });

  it("reads spans back over the window the new API wants", async () => {
    const env = memoryEnvStore({ ...keys });
    await wireTracing(env);
    let asked = "";
    const spans = await recentSpans(
      env,
      async (url) => {
        asked = url;
        return {
          status: 200,
          body: {
            data: [
              {
                name: "llm.complete",
                traceId: "t1",
                startTime: "2026-09-22T13:00:00Z",
                type: "GENERATION",
              },
            ],
          },
        };
      },
      { minutes: 30, limit: 5 },
    );
    expect(spans).toEqual([
      {
        name: "llm.complete",
        traceId: "t1",
        startTime: "2026-09-22T13:00:00Z",
        type: "GENERATION",
      },
    ]);
    expect(asked).toContain("/api/public/v2/observations?fromStartTime=");
    expect(asked).toContain("limit=5");
  });

  it("refuses to read when tracing is not wired", async () => {
    await expect(
      recentSpans(memoryEnvStore(), async () => ({ status: 200, body: null })),
    ).rejects.toThrow(/not wired/);
  });
});

describe("machine-local env names", () => {
  it("are left out of a blanket pull", async () => {
    const { MACHINE_LOCAL } = await import("../src/app/cli-env.js");
    expect(MACHINE_LOCAL.has("CREDENTIALS_CIPHER")).toBe(true);
  });
});
