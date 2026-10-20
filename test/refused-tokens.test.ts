/**
 * A refused token is due at once: kept, said once, re-made by renew (one try a day, two days),
 * queued on the desk the moment it is seen, and our own revoke queues the same. Synthetic site
 * `acme`, synthetic tokens; the integration runs a real local OAuth server.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { linkedinOauthConsent } from "../src/browser/flows/linkedin-oauth-consent.js";
import { HttpError, httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import type { SiteFacade } from "../src/sites/facade.js";
import { SiteError, sitesService } from "../src/sites/index.js";
import { pointTo } from "../src/sites/oauth.js";
import {
  dueToday,
  memoryRefusedTokens,
  type RefusedTokens,
  refusedLine,
} from "../src/sites/refused.js";
import { renewals, renewWording } from "../src/sites/renew.js";
import { type OAuthSpec, route, type SiteApi } from "../src/sites/types.js";
import { REVOKED_WORDS, sitesFor } from "../src/sites/wire.js";
import { fakeBrowser, fakeFetch } from "./fakes.js";

const DAY = 86_400_000;
const NAME = "ACME_REFRESH_TOKEN";

/** A site like TikTok: a refresh token, a who-am-I probe, a revoke endpoint. */
function acmeAt(origin: string): SiteApi {
  const oauth: OAuthSpec = {
    authorizeUrl: `${origin}/authorize`,
    tokenUrl: `${origin}/token`,
    scopes: ["me"],
    clientId: "ACME_CLIENT_ID",
    clientSecret: "ACME_CLIENT_SECRET",
    refreshToken: NAME,
    consent: { flow: "acme/oauth-consent" },
    revoke: { url: `${origin}/revoke`, token: "access" },
  };
  return {
    site: "acme",
    origin,
    probe: { path: "/me" },
    auth: { oauth },
    routes: [
      route({
        method: "GET",
        path: "/me",
        summary: "who the token is",
        request: z.object({}),
        api: async (_b, leg) => {
          const r = await leg.http.json<unknown>(`${origin}/me`, {
            headers: { authorization: `Bearer ${leg.token}` },
          });
          if (!r.ok) throw new HttpError("GET", `${origin}/me`, r.status);
          return r.body;
        },
      }),
    ],
    setup: [
      {
        name: "consent",
        makes: [NAME],
        needs: ["ACME_CLIENT_ID", "ACME_CLIENT_SECRET"],
        how: { oauth },
        summary: "consent once",
      },
    ],
  };
}

const catalog = { list: async () => [], get: async () => null, proofs: async () => ({}) };
const client = { ACME_CLIENT_ID: "cid", ACME_CLIENT_SECRET: "csecret" };

/** sitesFor over `acme` with a fake fetch; what it says to a person is kept in `said`. */
function wired(
  answer: Parameters<typeof fakeFetch>[0],
  env: Record<string, string>,
  refused: RefusedTokens = memoryRefusedTokens(),
  o: { kept?: string[] } = {},
) {
  const said: { text: string; ping: boolean }[] = [];
  const api = fakeFetch(answer);
  const sites = sitesFor({
    catalog,
    browser: fakeBrowser([]),
    sink: memorySink(),
    oauthPort: 9433,
    sites: [acmeAt("https://acme.test")],
    env: (n) => env[n],
    http: httpClient({ fetch: api.fetch }),
    flows: {},
    refused,
    notice: async (text, p) => {
      said.push({ text, ping: Boolean(p?.ping) });
    },
    kept: async () =>
      (o.kept ?? Object.keys(env)).map((name) => ({ name, updatedAt: null, expiresAt: null })),
  });
  return { sites, said, refused, api };
}

const refusing = () => ({
  body: { error: "invalid_grant", error_description: "Refresh token is invalid or expired" },
});

describe("refused tokens", () => {
  it("renew plans a refused name as due now, however far off its lapse", () => {
    const now = Date.parse("2026-10-16T08:00:00.000Z");
    const plan = renewals(
      [acmeAt("https://acme.test")],
      [],
      [{ name: NAME, updatedAt: null, expiresAt: new Date(now + 300 * DAY).toISOString() }],
      14 * DAY,
      now,
      [
        {
          name: NAME,
          site: "acme",
          account: null,
          since: "2026-10-15T14:02:00.000Z",
          words: "invalid_grant",
          tries: [],
        },
      ],
    );
    expect(plan.due.map((r) => [r.site, r.step, r.account])).toEqual([["acme", "consent", null]]);
    expect(renewWording(plan, null)[0]).toBe(
      "due: acme consent (refused since 2026-10-15 14:02 UTC)",
    );
  });

  it("a refusal is kept and said once per incident, not per call", async () => {
    const w = wired(refusing, { ...client, [NAME]: "rt-old" });
    for (let i = 0; i < 3; i++)
      await expect(w.sites.call("acme", "GET", "/me", {})).rejects.toThrow(/was refused/);
    expect(w.said).toHaveLength(1);
    expect(w.said[0]?.text).toMatch(
      /^token refused: ACME_REFRESH_TOKEN \(acme\) refused since .*invalid_grant/,
    );
    expect(w.refused.list().map((r) => [r.name, r.site, r.account])).toEqual([
      [NAME, "acme", null],
    ]);
    // The desk queues it once; a second claim finds nothing new.
    expect((await w.sites.claimRefused?.())?.map((r) => r.name)).toEqual([NAME]);
    expect(await w.sites.claimRefused?.()).toEqual([]);
    expect((await w.sites.status("acme")).refused?.[0]?.name).toBe(NAME);
  });

  it("a 401 on the who-am-I probe is a refusal of the token behind it", async () => {
    const w = wired(
      (r) =>
        r.url.pathname === "/token"
          ? { body: { access_token: "at-1", expires_in: 3600 } }
          : { status: 401, body: { error: "unauthorized" } },
      { ...client, [NAME]: "rt-1" },
    );
    await expect(w.sites.call("acme", "GET", "/me", {})).rejects.toThrow(/was refused/);
    expect(w.refused.list()[0]?.name).toBe(NAME);
  });

  it("two failed days and renew stops, with one notice that pings; a new token restarts it", async () => {
    const store = memoryRefusedTokens();
    const day1 = new Date("2026-10-16T09:00:00.000Z");
    store.refuse({ name: NAME, site: "acme", account: null, words: "invalid_grant" }, day1);
    // No client id: the consent cannot run, so each day's try fails.
    const w = wired(refusing, { [NAME]: "rt-old" }, store);
    const tries: string[][] = [];
    const days = ["2026-10-16", "2026-10-16", "2026-10-17", "2026-10-18"];
    for (const d of days) {
      vi.setSystemTime(new Date(`${d}T09:00:00.000Z`));
      const r = await w.sites.renew?.({ names: [NAME] });
      tries.push(r?.results.map((x) => x.step) ?? []);
    }
    vi.useRealTimers();
    // Once on day one (a rerun that day skips it), once on day two, never on day three.
    expect(tries).toEqual([["consent"], [], ["consent"], []]);
    const pings = w.said.filter((s) => s.ping);
    expect(pings).toHaveLength(1);
    expect(pings[0]?.text).toMatch(
      /renew stopped: .*gave up .* after 2 days \(consent needs ACME_CLIENT_ID.*\): needs a person\. Run: autobrowse site setup acme consent$/,
    );
    expect(dueToday(store.list(), new Date("2026-10-19T09:00:00.000Z"))).toEqual([]);
    // A setup that makes it again ends the incident.
    store.clear([NAME]);
    expect(store.list()).toEqual([]);
  });

  it("a try that never ended uses its day; the next pass past the last day gives up", () => {
    const store = memoryRefusedTokens();
    store.refuse(
      { name: NAME, site: "acme", account: null, words: "x" },
      new Date("2026-10-16T00:00:00Z"),
    );
    store.start(NAME, new Date("2026-10-16T01:00:00Z"));
    store.start(NAME, new Date("2026-10-17T01:00:00Z"));
    expect(store.stale(new Date("2026-10-17T05:00:00Z"))).toEqual([]);
    const gone = store.stale(new Date("2026-10-18T01:00:00Z"));
    expect(gone.map((r) => r.name)).toEqual([NAME]);
    expect(refusedLine(gone[0] as never)).toMatch(/gave up .* after 2 days: needs a person/);
    expect(store.stale(new Date("2026-10-19T01:00:00Z"))).toEqual([]);
  });

  it("our revoke ends the grant, marks every name it covered, and says so", async () => {
    const w = wired(
      (r) =>
        r.url.pathname === "/token"
          ? { body: { access_token: "at-1", expires_in: 3600 } }
          : { body: {} },
      {
        ...client,
        [NAME]: "rt-1",
        // An alias pointing at the real copy, and an unrelated account's own grant.
        ACME_REFRESH_TOKEN__W_WREN_COM: pointTo(NAME),
        ACME_REFRESH_TOKEN__OTHER_WREN_COM: "rt-other",
      },
    );
    const { revoked } = (await w.sites.revoke?.("acme")) ?? { revoked: [] };
    expect(revoked).toEqual([NAME, "ACME_REFRESH_TOKEN__W_WREN_COM"]);
    const hit = w.api.calls.find((c) => c.url.pathname === "/revoke");
    expect(new URLSearchParams(hit?.body).get("token")).toBe("at-1");
    expect(w.refused.list().map((r) => [r.name, r.words])).toEqual([
      [NAME, REVOKED_WORDS],
      ["ACME_REFRESH_TOKEN__W_WREN_COM", REVOKED_WORDS],
    ]);
    expect(w.said[0]?.text).toMatch(/^revoked the acme grant/);
  });
});

describe("the desk queues re-makes", () => {
  /** A stand-in Context that keeps every one-way send. */
  function ctxOf() {
    const sent: { service: string; handler: string; req: unknown; opts: unknown }[] = [];
    const ctx = {
      request: () => ({ id: "inv_1", headers: new Map() }),
      run: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
      serviceSendClient: ({ name }: { name: string }) =>
        new Proxy(
          {},
          {
            get: (_t, handler: string) => (req: unknown, opts: unknown) =>
              sent.push({ service: name, handler, req, opts }),
          },
        ),
    };
    return { ctx: ctx as never, sent };
  }
  const rows = memoryRefusedTokens();
  const facade: SiteFacade = {
    list: async () => [],
    status: async (site) => ({ site, origin: "o", authed: true, routes: [], setup: [] }),
    call: async () => {
      rows.refuse({ name: NAME, site: "acme", account: null, words: "invalid_grant" }, new Date());
      throw new SiteError(409, `${NAME} was refused (invalid_grant); re-consent the account`);
    },
    setup: async () => ({ made: [] }),
    caps: (day) => ({ day: day ?? "2026-10-16", used: {}, calls: [] }),
    claimRefused: async () => rows.claim(),
    revoke: async () => {
      const now = new Date();
      for (const name of [NAME, "ACME_REFRESH_TOKEN__W_WREN_COM"])
        rows.refuse({ name, site: "acme", account: null, words: REVOKED_WORDS }, now);
      return { revoked: [NAME, "ACME_REFRESH_TOKEN__W_WREN_COM"] };
    },
  };
  const h = (
    sitesService(facade, "desk") as unknown as {
      service: Record<string, (...args: never) => Promise<unknown>>;
    }
  ).service;
  const opts = (o: unknown) =>
    (o as { getOpts: () => { idempotencyKey?: string; delay?: number } }).getOpts();

  it("a refused call queues one renew of that name, once per incident", async () => {
    const { ctx, sent } = ctxOf();
    for (let i = 0; i < 2; i++)
      await expect(h.call?.(ctx, { site: "acme", method: "GET", path: "/me" })).rejects.toThrow(
        /was refused/,
      );
    expect(sent.map((s) => [s.service, s.handler, s.req])).toEqual([
      ["desk", "renew", { names: [NAME] }],
    ]);
    expect(opts(sent[0]?.opts).idempotencyKey).toMatch(/^remake ACME_REFRESH_TOKEN /);
    rows.clear([NAME]);
  });

  it("revoke queues the re-make of every token the grant covered, after the wait asked", async () => {
    const { ctx, sent } = ctxOf();
    expect(await h.revoke?.(ctx, { site: "acme", after: 5 })).toEqual({
      revoked: [NAME, "ACME_REFRESH_TOKEN__W_WREN_COM"],
      after: 5,
    });
    expect(sent.map((s) => s.req)).toEqual([
      { names: [NAME] },
      { names: ["ACME_REFRESH_TOKEN__W_WREN_COM"] },
    ]);
    expect(sent.map((s) => opts(s.opts).delay)).toEqual([300_000, 300_000]);
  });

  /** A facade whose token is refused until `renew` makes it again; `remade` is what renew answers. */
  function remaking(remade: boolean) {
    const kept = memoryRefusedTokens();
    let good = false;
    let calls = 0;
    const f: SiteFacade = {
      ...facade,
      call: async () => {
        calls++;
        if (good) return { ok: true };
        kept.refuse(
          { name: NAME, site: "acme", account: null, words: "invalid_grant" },
          new Date(),
        );
        throw new SiteError(409, `${NAME} was refused (invalid_grant); re-consent the account`);
      },
      claimRefused: async () => kept.claim(),
      refused: async () => kept.list(),
    };
    const awaited: { req: unknown; key?: string }[] = [];
    const base = ctxOf();
    const ctx = {
      ...(base.ctx as object),
      serviceClient: () => ({
        renew: async (req: unknown, o: unknown) => {
          awaited.push({ req, key: opts(o).idempotencyKey });
          good = remade;
          return {
            results: [{ site: "acme", step: "s", account: null, names: [NAME], ok: remade }],
          };
        },
      }),
    } as never;
    const handlers = (
      sitesService(f, "desk") as unknown as {
        service: Record<string, (...args: never) => Promise<unknown>>;
      }
    ).service;
    return { handlers, ctx, sent: base.sent, awaited, calls: () => calls };
  }

  it("a call whose token was refused waits for its re-make, then runs once more", async () => {
    const t = remaking(true);
    expect(
      await t.handlers.call?.(t.ctx, { site: "acme", method: "POST", path: "/post", input: {} }),
    ).toEqual({ ok: true });
    expect(t.calls()).toBe(2);
    // Awaited under the queued re-make's key, so the two are one run; nothing else is queued.
    expect(t.awaited).toEqual([{ req: { names: [NAME] }, key: expect.stringMatching(/^remake /) }]);
    expect(t.sent).toEqual([]);
  });

  it("a re-make that fails leaves the refusal terminal, with no second try", async () => {
    const t = remaking(false);
    await expect(
      t.handlers.call?.(t.ctx, { site: "acme", method: "POST", path: "/post", input: {} }),
    ).rejects.toThrow(/was refused/);
    expect(t.calls()).toBe(1);
  });
});

describe("refused, then re-made (local OAuth server)", () => {
  let server: Server;
  let origin = "";
  /** The grant the server honours; the test revokes it from outside first. */
  const grant = { refresh: "rt-new", access: "at-new" };
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const f = new URLSearchParams(body);
        const send = (status: number, json: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(json));
        };
        if (req.url === "/token" && f.get("grant_type") === "authorization_code")
          return f.get("code") === "code-1"
            ? send(200, {
                access_token: grant.access,
                refresh_token: grant.refresh,
                expires_in: 3600,
              })
            : send(400, { error: "invalid_grant" });
        if (req.url === "/token")
          return f.get("refresh_token") === grant.refresh
            ? send(200, { access_token: grant.access, expires_in: 3600 })
            : // Like TikTok: an HTTP 200 with the error in the body.
              send(200, {
                error: "invalid_grant",
                error_description: "Refresh token is invalid or expired",
              });
        if (req.url === "/me")
          return req.headers.authorization === `Bearer ${grant.access}`
            ? send(200, { id: "acme-user" })
            : send(401, { error: "unauthorized" });
        send(404, {});
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  it("a dead refresh token is refused, said once, made again by renew, and calls work again", async () => {
    const port = 9434;
    const env: Record<string, string> = { ...client, [NAME]: "rt-revoked" };
    const sink = memorySink();
    const browser = fakeBrowser([]);
    let consents = 0;
    browser.on(linkedinOauthConsent, async (input) => {
      consents++;
      const u = new URL(input.url);
      await fetch(
        `http://127.0.0.1:${port}/oauth/callback?code=code-1&state=${u.searchParams.get("state")}`,
      );
      return { landed: "" };
    });
    const said: string[] = [];
    const sites = sitesFor({
      catalog,
      browser,
      sink,
      oauthPort: port,
      sites: [acmeAt(origin)],
      env: (n) => env[n],
      flows: { "acme/oauth-consent": linkedinOauthConsent as never },
      refused: memoryRefusedTokens(),
      notice: async (text) => {
        said.push(text);
      },
      kept: async () => [{ name: NAME, updatedAt: null, expiresAt: null }],
    });
    // The daily pass probes first: the refusal is found, kept, said, and made again in one go.
    const r = await sites.renew?.();
    expect(r?.results.map((x) => [x.site, x.step, x.ok])).toEqual([["acme", "consent", true]]);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^token refused: ACME_REFRESH_TOKEN \(acme\)/);
    expect(consents).toBe(1);
    expect(sink.values[NAME]).toBe("rt-new");
    expect(await sites.refused?.()).toEqual([]);
    expect(await sites.call("acme", "GET", "/me", {})).toEqual({ id: "acme-user" });
    // Nothing left to make: the next pass tries nothing.
    expect((await sites.renew?.())?.results).toEqual([]);
  });
});
