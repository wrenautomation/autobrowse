import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BrowserFlow, FlowRunner } from "../src/browser/flow.js";
import { defineFlow } from "../src/browser/flow.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { perplexity, route, type SiteApi, siteFacade, web, youtube } from "../src/sites/index.js";
import type { OAuthSpec } from "../src/sites/types.js";
import { consentProviderOf } from "../src/sites/wire.js";
import { fakeFetch } from "./fakes.js";

const look = defineFlow<{ q: string }, { hits: number }>({
  site: "web",
  name: "look",
  async run() {
    return { hits: 0 };
  },
});

/** A runner that records the site (profile) each flow ran under. */
function sitedRunner() {
  const ran: string[] = [];
  const runner: FlowRunner = {
    async run(flow: BrowserFlow<unknown, unknown>) {
      ran.push(flow.site);
      return { hits: 1 } as never;
    },
  } as FlowRunner;
  return { runner, ran };
}

const siteOf = (signedOut: boolean): SiteApi => ({
  site: "web",
  origin: "https://web",
  auth: { open: true },
  ...(signedOut ? { signedOut: true as const } : {}),
  routes: [
    route({
      method: "GET",
      path: "/look",
      summary: "look",
      request: z.object({ q: z.string() }),
      browser: { flow: "web/look" },
    }),
  ],
  setup: [],
});

function facadeOf(s: SiteApi) {
  const { runner, ran } = sitedRunner();
  const asked: string[] = [];
  const sites = siteFacade([s], {
    http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
    env: () => undefined,
    sink: memorySink(),
    runner,
    flow: (n) => (n === "web/look" ? (look as never) : null),
    accountFor: async (x) => {
      asked.push(x.site);
      return "policy@wren.test";
    },
    profileFor: async (at, account) => `${at}@${account.split("@")[0]}`,
  });
  return { sites, ran, asked };
}

describe("signed-out sites", () => {
  it("web is signed out; perplexity signs in via google", () => {
    expect(web.signedOut).toBe(true);
    expect(perplexity.signedOut).toBeUndefined();
  });

  it("a signed-out browser leg never asks the policy and runs in the site's own profile", async () => {
    const { sites, ran, asked } = facadeOf(siteOf(true));
    expect(await sites.call("web", "GET", "/look", { q: "x" })).toEqual({ hits: 1 });
    await sites.status("web");
    await sites.list();
    expect(asked).toEqual([]);
    expect(ran).toEqual(["web"]);
  });

  it("a caller-named account still wins", async () => {
    const { sites, ran, asked } = facadeOf(siteOf(true));
    await sites.call("web", "GET", "/look", { q: "x" }, "named@wren.test");
    expect(asked).toEqual([]);
    expect(ran).toEqual(["web@named"]);
  });

  it("without signedOut the policy's account picks the profile", async () => {
    const { sites, ran, asked } = facadeOf(siteOf(false));
    await sites.call("web", "GET", "/look", { q: "x" });
    expect(asked).toEqual(["web"]);
    expect(ran).toEqual(["web@policy"]);
  });
});

describe("consent of a site made via a provider", () => {
  it("opens in the account's provider profile, where its browser legs run", async () => {
    const redirect = "https://wren.test/cb";
    const ran: string[] = [];
    const consent = defineFlow<{ url: string }, { landed: string }>({
      site: "vs",
      name: "oauth-consent",
      async run(_fp, { url }) {
        return { landed: `${redirect}?code=c&state=${new URL(url).searchParams.get("state")}` };
      },
    });
    const runner = {
      async run(flow: BrowserFlow<unknown, unknown>, input: unknown) {
        ran.push(flow.site);
        return flow.run({} as never, input);
      },
    } as FlowRunner;
    const oauth: OAuthSpec = {
      authorizeUrl: "https://vs/auth",
      tokenUrl: "https://vs/token",
      scopes: ["a"],
      clientId: "VS_ID",
      clientSecret: "VS_SECRET",
      refreshToken: "VS_REFRESH",
      redirect,
      consent: { flow: "vs/oauth-consent" },
    };
    const vs: SiteApi = {
      site: "vs",
      origin: "https://vs",
      via: "google",
      auth: { oauth },
      routes: [],
      setup: [{ name: "consent", how: { oauth }, makes: ["VS_REFRESH"], summary: "" }],
    };
    const sites = siteFacade([vs], {
      http: httpClient({
        fetch: fakeFetch(() => ({ body: { access_token: "t", refresh_token: "r" } })).fetch,
      }),
      env: (n) => (n === "VS_ID" || n === "VS_SECRET" ? "x" : undefined),
      sink: memorySink(),
      runner,
      flow: (n) => (n === "vs/oauth-consent" ? (consent as never) : null),
      accountFor: async () => "me@wren.test",
      providerOf: consentProviderOf,
      profileFor: async (at, account) => `${at}@${account.split("@")[0]}`,
    });
    await sites.setup("vs", "consent");
    expect(ran).toEqual(["google@me"]);
  });
});

describe("consent provider", () => {
  it("is the site's via when set, else its consent flow's site, else null", () => {
    expect(consentProviderOf(perplexity)).toBe("google");
    expect(consentProviderOf({ ...web, via: "microsoft" })).toBe("microsoft");
    expect(consentProviderOf(youtube)).toBe("google");
    expect(consentProviderOf(web)).toBeNull();
  });
});
