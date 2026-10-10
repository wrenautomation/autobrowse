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
      "account/reset-mail-probe",
      "calcom/api-key",
      "discord/bot-token",
      "discord/invite",
      "facebook/oauth-consent",
      "fingerprint/check",
      "google-admin/dkim-generate",
      "google-admin/dkim-start",
      "google-admin/workspace-logo",
      "google/maps-reviews",
      "google/oauth-consent",
      "google/profile-photo",
      "google/youtube-community-post",
      "hubspot/connector-keys",
      "instagram/comment",
      "instagram/create-post",
      "instagram/follow",
      "instagram/like",
      "instagram/oauth-consent",
      "instagram/post",
      "instagram/profile-name",
      "instagram/search",
      "intuit/connector-keys",
      "jobber/connector-keys",
      "linkedin/activity",
      "linkedin/audience",
      "linkedin/company",
      "linkedin/company-jobs",
      "linkedin/company-people",
      "linkedin/company-posts",
      "linkedin/connect",
      "linkedin/connections",
      "linkedin/create-post",
      "linkedin/dashboard",
      "linkedin/follow",
      "linkedin/inbox",
      "linkedin/like",
      "linkedin/message",
      "linkedin/notifications",
      "linkedin/oauth-consent",
      "linkedin/post-analytics",
      "linkedin/profile",
      "linkedin/relationship",
      "linkedin/search-people",
      "linkedin/search-posts",
      "linkedin/withdraw",
      "loom/delete",
      "loom/rename",
      "loom/upload",
      "npm/create-org",
      "npm/granular-token",
      "npm/trusted-publisher",
      "outlook/oauth-consent",
      "perplexity/ask",
      "reddit/comment",
      "reddit/message",
      "reddit/profile-name",
      "reddit/read",
      "reddit/submit",
      "tiktok/oauth-consent",
      "tiktok/post-comments",
      "tiktok/profile-name",
      "web/google",
      "web/google-place",
      "x/follow",
      "x/like",
      "x/oauth-consent",
      "x/post",
      "x/posts",
      "x/profile",
      "x/profile-name",
      "x/reply",
      "x/search",
    ]);
    const svc = browserService({ runner: { run: async () => "ok" as never } });
    expect(svc.name).toBe("browser");
  });
});
