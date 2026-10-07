import { describe, expect, it } from "vitest";
import { currentCall } from "../src/browser/attempt.js";
import { HttpError } from "../src/clients/http.js";
import type { SiteFacade } from "../src/sites/facade.js";
import { DESK_SERVICE, SITES_SERVICE, SiteError, sitesService } from "../src/sites/index.js";

/** A stand-in Context: `run` calls through and keeps each step's name and retry policy. */
function ctxOf(headers: Record<string, string> = {}) {
  const steps: { name: string; attempts: number | undefined }[] = [];
  const ctx = {
    request: () => ({ id: "inv_1", headers: new Map(Object.entries(headers)) }),
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
  call: async (site, method, path, input, _account, from) => {
    calls.push({ site, method, path, input, from, call: currentCall() });
    if (path === "/rest/boom") throw new SiteError(502, "workflow failed");
    if (path === "/rest/flaky") throw new Error("socket hang up");
    if (path === "/rest/broke") throw new HttpError("CALL", "https://x.test/rest/broke", 402);
    if (path === "/rest/busy") throw new HttpError("CALL", "https://x.test/rest/busy", 429);
    return { id: "urn:li:share:1" };
  },
  setup: async () => ({ made: ["LINKEDIN_ACCESS_TOKEN"] }),
  caps: (day, site) => ({
    day: day ?? "2026-10-01",
    used: { [`${site}|a|company`]: 1 },
    calls: [],
  }),
};
const h = (
  sitesService(facade) as unknown as { service: Record<string, (...args: never) => unknown> }
).service;

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

  it("says who is calling: the request's caller, else the x-caller header, and the invocation", async () => {
    await h.call?.(ctxOf({ "x-caller": "wren:demo" }).ctx, {
      site: "linkedin",
      method: "GET",
      path: "/rest/posts",
    });
    expect(calls.at(-1)).toMatchObject({ from: { caller: "wren:demo", invocation: "inv_1" } });
    await h.call?.(ctxOf({ "x-caller": "wren:demo" }).ctx, {
      site: "linkedin",
      method: "GET",
      path: "/rest/posts",
      caller: "wren:research",
    });
    expect(calls.at(-1)).toMatchObject({ from: { caller: "wren:research" } });
    await h.call?.(ctxOf().ctx, { site: "linkedin", method: "GET", path: "/rest/posts" });
    expect(calls.at(-1)).toMatchObject({ from: { caller: null } });
  });

  it("caps reads a day's ledger, the day checked", async () => {
    const { ctx } = ctxOf();
    expect(await h.caps?.(ctx, { site: "linkedin" })).toMatchObject({
      used: { "linkedin|a|company": 1 },
    });
    await expect(h.caps?.(ctx, { day: "yesterday" })).rejects.toMatchObject({ code: 400 });
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
    // A platform's lasting refusal ends the call under its own status; a 429 waits and retries.
    await expect(
      h.call?.(ctx, { site: "linkedin", method: "GET", path: "/rest/broke" }),
    ).rejects.toMatchObject({ name: "TerminalError", code: 402 });
    await expect(
      h.call?.(ctx, { site: "linkedin", method: "GET", path: "/rest/busy" }),
    ).rejects.toMatchObject({ name: "HttpError", status: 429 });
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

  it("is named sites by default; the Mac serves the same handlers as desk", async () => {
    expect(SITES_SERVICE).toBe("sites");
    expect(DESK_SERVICE).toBe("desk");
    expect(sitesService(facade).name).toBe("sites");
    const desk = sitesService(facade, DESK_SERVICE);
    expect(desk.name).toBe("desk");
    const d = (desk as unknown as { service: Record<string, (...args: never) => unknown> }).service;
    expect(Object.keys(d).sort()).toEqual(Object.keys(h).sort());
    const { ctx, steps } = ctxOf();
    expect(await d.call?.(ctx, { site: "linkedin", method: "GET", path: "/rest/posts" })).toEqual({
      id: "urn:li:share:1",
    });
    expect(steps).toEqual([{ name: "sites linkedin GET /rest/posts", attempts: 300 }]);
  });

  it("a call runs as the durable call, so a rerun never repeats a browser leg's post", async () => {
    await h.call?.(ctxOf().ctx, { site: "linkedin", method: "POST", path: "/rest/posts" });
    expect(calls.at(-1)).toMatchObject({ call: "inv_1 sites linkedin POST /rest/posts" });
  });
});
