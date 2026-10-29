import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BrowserFlow, FlowRunner } from "../src/browser/flow.js";
import { defineFlow } from "../src/browser/flow.js";
import { AccessRefused, NeedsHuman } from "../src/browser/session.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { accessError } from "../src/sites/facade.js";
import { route, type SiteApi, SiteError, siteFacade } from "../src/sites/index.js";
import { fakeFetch } from "./fakes.js";

const look = defineFlow<{ q: string }, unknown>({
  site: "web",
  name: "look",
  async run() {
    return null;
  },
});

const site: SiteApi = {
  site: "web",
  origin: "https://web",
  auth: { open: true },
  signedOut: true,
  routes: (["GET", "POST"] as const).map((method) =>
    route({
      method,
      path: "/look",
      summary: "look",
      request: z.object({ q: z.string() }),
      browser: { flow: "web/look" },
    }),
  ),
  setup: [],
};

/** A facade whose one flow throws `err`. */
function facadeThrowing(err: Error) {
  const runner = {
    async run(_flow: BrowserFlow<unknown, unknown>) {
      throw err;
    },
  } as FlowRunner;
  return siteFacade([site], {
    http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
    env: () => undefined,
    sink: memorySink(),
    runner,
    flow: (n) => (n === "web/look" ? (look as never) : null),
  });
}

const caught = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe("access codes", () => {
  it("a 429 is rate_limited unless said otherwise", () => {
    expect(new SiteError(429, "cap").code).toBe("rate_limited");
    expect(new SiteError(404, "gone").code).toBeUndefined();
  });

  it("maps walls and refusals to codes; anything else stays", () => {
    expect(accessError(new NeedsHuman("x: login page", "login"))).toMatchObject({
      status: 401,
      code: "need_login",
    });
    expect(accessError(new NeedsHuman("x: captcha", "captcha"))).toMatchObject({
      status: 403,
      code: "platform_blocked",
    });
    expect(accessError(new AccessRefused("upstream_broken", "x: HTTP 503"))).toMatchObject({
      status: 502,
      code: "upstream_broken",
    });
    expect(accessError(new NeedsHuman("x: check it"))).toBeNull();
    expect(accessError(new Error("x"))).toBeNull();
  });

  it("a read's login wall is a coded SiteError", async () => {
    const sites = facadeThrowing(new NeedsHuman("web: signed out: https://web/x", "login"));
    const e = await caught(sites.call("web", "GET", "/look", { q: "x" }));
    expect(e).toBeInstanceOf(SiteError);
    expect(e).toMatchObject({ status: 401, code: "need_login" });
  });

  it("a write's wall stays a NeedsHuman", async () => {
    const sites = facadeThrowing(new NeedsHuman("web: signed out", "login"));
    expect(await caught(sites.call("web", "POST", "/look", { q: "x" }))).toBeInstanceOf(NeedsHuman);
  });
});
