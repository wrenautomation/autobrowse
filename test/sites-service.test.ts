import { describe, expect, it } from "vitest";
import type { SiteFacade } from "../src/sites/facade.js";
import { SiteError, sitesService } from "../src/sites/index.js";

/** A stand-in Context: `run` calls through and keeps each step's name and retry policy. */
function ctxOf() {
  const steps: { name: string; attempts: number | undefined }[] = [];
  const ctx = {
    run: async <T>(
      name: string,
      fn: () => Promise<T>,
      opts?: { maxRetryAttempts?: number },
    ): Promise<T> => {
      steps.push({ name, attempts: opts?.maxRetryAttempts });
      return fn();
    },
  };
  return { ctx: ctx as never, steps };
}

const calls: unknown[] = [];
const facade: SiteFacade = {
  list: async () => [],
  status: async (site) => {
    if (site !== "linkedin") throw new SiteError(404, `no site api named ${site}`);
    return { site, origin: "o", authed: true, routes: [], setup: [] };
  },
  call: async (site, method, path, input) => {
    calls.push({ site, method, path, input });
    if (path === "/rest/boom") throw new SiteError(502, "workflow failed");
    if (path === "/rest/flaky") throw new Error("socket hang up");
    return { id: "urn:li:share:1" };
  },
  setup: async () => ({ made: ["LINKEDIN_ACCESS_TOKEN"] }),
};
const h = (sitesService(facade) as unknown as { service: Record<string, Function> }).service;

describe("sites service", () => {
  it("a read retries, a write runs once; the input passes through", async () => {
    const { ctx, steps } = ctxOf();
    expect(await h.call?.(ctx, { site: "linkedin", method: "GET", path: "/rest/posts" })).toEqual({
      id: "urn:li:share:1",
    });
    await h.call?.(ctx, {
      site: "linkedin",
      method: "POST",
      path: "/rest/posts",
      input: { commentary: "hi" },
    });
    expect(calls.at(-1)).toMatchObject({ method: "POST", input: { commentary: "hi" } });
    expect(steps.map((s) => s.attempts)).toEqual([300, 1]);
    expect(steps[1]?.name).toBe("sites linkedin POST /rest/posts");
  });

  it("a SiteError is terminal under its status; anything else is left to retry", async () => {
    const { ctx } = ctxOf();
    await expect(h.status?.(ctx, { site: "nope" })).rejects.toMatchObject({
      name: "TerminalError",
      code: 404,
    });
    await expect(
      h.call?.(ctx, { site: "linkedin", method: "GET", path: "/rest/boom" }),
    ).rejects.toMatchObject({ name: "TerminalError", code: 502 });
    await expect(
      h.call?.(ctx, { site: "linkedin", method: "GET", path: "/rest/flaky" }),
    ).rejects.toMatchObject({ name: "Error", message: "socket hang up" });
  });

  it("a bad request never reaches the facade", async () => {
    const { ctx, steps } = ctxOf();
    await expect(
      h.call?.(ctx, { site: "linkedin", method: "FETCH", path: "x" }),
    ).rejects.toMatchObject({ name: "TerminalError", code: 400 });
    expect(steps).toEqual([]);
    expect(await h.setup?.(ctx, { site: "linkedin", step: "consent" })).toEqual({
      made: ["LINKEDIN_ACCESS_TOKEN"],
    });
  });
});
