import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defineFlow, FlowFailed, flowRunner } from "../src/browser/flow.js";
import { readSteps, watchedRuns, watches } from "../src/browser/watch.js";

describe("watched flows", () => {
  it("names flows by all, site or site/flow", () => {
    expect(watches("all", "cloudflare", "login")).toBe(true);
    expect(watches("cloudflare", "cloudflare", "login")).toBe(true);
    expect(watches(" meta , cloudflare/login", "cloudflare", "login")).toBe(true);
    expect(watches("cloudflare/api-token", "cloudflare", "login")).toBe(false);
    expect(watches(undefined, "cloudflare", "login")).toBe(false);
  });

  const server = createServer((_q, r) =>
    r
      .writeHead(200, { "content-type": "text/html" })
      .end("<title>t</title><input id=card aria-label=Card><button>Pay</button>"),
  );
  const ready = new Promise<string>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}/pay`),
    ),
  );
  afterAll(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), "autobrowse-watch-"));
  const artifactsDir = join(dir, "artifacts");
  const runner = flowRunner(
    {
      tier: "local",
      channel: "chromium",
      profilesDir: join(dir, "profiles"),
      artifactsDir,
      headless: true,
      watchFlows: "scratch",
    },
    { pace: null },
  );

  it("writes every step with a masked shot and aria, and keeps the trace when it works", async () => {
    const url = await ready;
    const pay = defineFlow<undefined, void>({
      site: "scratch",
      name: "pay",
      async run(fp) {
        await fp.open(url);
        await fp.act(
          { kind: "fill", value: "4242424242424242" },
          { role: "textbox", name: "Card" },
          { goal: "type the card" },
        );
        await fp.act({ kind: "click" }, { role: "button", name: "Pay" }, { goal: "pay" });
      },
    });
    await runner.run(pay, undefined);
    const [run] = watchedRuns(artifactsDir);
    const steps = readSteps(run as string);
    expect(steps.map((s) => [s.kind, s.goal, s.outcome])).toEqual([
      ["open", `open ${url}`, "ok"],
      ["act", "type the card", "ok"],
      ["act", "pay", "ok"],
    ]);
    expect(steps[1]?.op).toBe("fill");
    // The filled value is never written: not in the ledger, not in the aria.
    const ledger = readFileSync(join(run as string, "steps.jsonl"), "utf8");
    expect(ledger).not.toContain("4242");
    expect(readFileSync(join(run as string, steps[2]?.aria as string), "utf8")).not.toContain(
      "4242",
    );
    expect(existsSync(join(run as string, steps[2]?.shot as string))).toBe(true);
    expect(existsSync(join(run as string, "trace.zip"))).toBe(true);
  }, 60_000);

  it("marks the step that broke, and the failure points at the steps", async () => {
    const url = await ready;
    const broken = defineFlow<undefined, void>({
      site: "scratch",
      name: "broken",
      async run(fp) {
        await fp.open(url);
        await fp.act(
          { kind: "click" },
          { role: "button", name: "Gone" },
          { goal: "press gone", timeoutMs: 500 },
        );
      },
    });
    const err = await runner.run(broken, undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowFailed);
    const steps = readSteps((err as FlowFailed).artifacts.steps as string);
    expect(steps.at(-1)).toMatchObject({ goal: "press gone", outcome: "failed" });
    expect(steps.at(-1)?.error).toBeTruthy();
  }, 60_000);
});
