import * as restate from "@restatedev/restate-sdk";
import { describe, expect, it } from "vitest";
import { defineFlow, FlowFailed, type FlowRunner } from "../src/browser/flow.js";
import { NeedsHuman } from "../src/browser/session.js";
import {
  BROWSER_CODE,
  BROWSER_FLOWS,
  browserService,
  runLeg,
} from "../src/engine/browser-service.js";

const flow = defineFlow<{ x: number }, string>({ site: "s", name: "f", run: async () => "ok" });

describe("browser service", () => {
  it("a person needed or a broken flow is terminal with artifacts; the rest retries", async () => {
    const human: FlowRunner = {
      run: async () => {
        const e = new NeedsHuman("s: captcha");
        e.artifacts = { screenshot: "/a.png" };
        throw e;
      },
    };
    const err = await runLeg(human, flow, { x: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(restate.TerminalError);
    expect((err as restate.TerminalError).code).toBe(BROWSER_CODE.needsHuman);
    expect(JSON.parse((err as Error).message)).toMatchObject({
      artifacts: { screenshot: "/a.png" },
    });
    const broken: FlowRunner = {
      run: async () => {
        throw new FlowFailed("s/f", new Error("no row"), {});
      },
    };
    expect(
      ((await runLeg(broken, flow, { x: 1 }).catch((e: unknown) => e)) as restate.TerminalError)
        .code,
    ).toBe(BROWSER_CODE.failed);
    const flaky: FlowRunner = {
      run: async () => {
        throw new Error("ECONNRESET");
      },
    };
    await expect(runLeg(flaky, flow, { x: 1 })).rejects.toThrow(/ECONNRESET/);
    await expect(runLeg(flaky, flow, { x: 1 })).rejects.not.toBeInstanceOf(restate.TerminalError);
  });
  it("names the fixed legs site/name and builds the service", () => {
    expect(Object.keys(BROWSER_FLOWS).sort()).toEqual([
      "cloudflare/buy",
      "facebook/oauth-consent",
      "google-admin/dkim-generate",
      "google-admin/dkim-start",
      "google-admin/workspace-logo",
      "google/oauth-consent",
      "google/youtube-community-post",
      "instagram/create-post",
      "instagram/oauth-consent",
      "instantly/warmup",
      "linkedin/oauth-consent",
      "outlook/oauth-consent",
      "tiktok/oauth-consent",
      "x/oauth-consent",
    ]);
    const svc = browserService({ runner: { run: async () => "ok" as never } });
    expect(svc.name).toBe("browser");
  });
});
