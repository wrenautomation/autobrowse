import { describe, expect, it } from "vitest";
import { memoryEffects, memorySink, runFlow } from "../../index.js";
import { keyWorks, planSchema, workflow } from "./index.js";

const deps = () => ({ browser: { run: async () => undefined as never }, sink: memorySink() });

describe("anthropic-console-api-key", () => {
  it("parses the recorded example; the key lands in ANTHROPIC_API_KEY by default", () => {
    const plan = planSchema.parse({ name: "autobrowse-prod" });
    expect(plan).toMatchObject({ dryRun: false, keepAs: "ANTHROPIC_API_KEY" });
    expect(planSchema.safeParse({ name: "x", keepAs: "lower case" }).success).toBe(false);
  });

  it("dry run plans and stops before anything irreversible", async () => {
    const plan = planSchema.parse({ dryRun: true, name: "autobrowse-prod" });
    const out = await runFlow(memoryEffects().fx, workflow, deps(), plan);
    expect(out.status).toBe("planned");
    expect(out.results["create-key"]?.status).toBe("planned");
  });

  it("proves a key with a free models list, header not URL", async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push([url, init]);
      return new Response("{}", { status: url.includes("?") && seen.length === 1 ? 200 : 401 });
    }) as typeof fetch;
    expect(await keyWorks("sk-ant-api03-test", f)).toBe(true);
    expect(await keyWorks("sk-ant-api03-test", f)).toBe(false);
    expect(seen[0]?.[0]).not.toContain("sk-ant");
    expect(seen[0]?.[1]?.headers).toMatchObject({ "x-api-key": "sk-ant-api03-test" });
  });
});
