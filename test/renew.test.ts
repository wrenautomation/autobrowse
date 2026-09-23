import { describe, expect, it } from "vitest";
import { linkedinOauthConsent } from "../src/browser/flows/linkedin-oauth-consent.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { siteFacade } from "../src/sites/facade.js";
import { linkedin, npm, youtube } from "../src/sites/index.js";
import { nextLapse, renewals, renewDue, renewWording } from "../src/sites/renew.js";
import { fakeBrowser, fakeFetch } from "./fakes.js";

const wren = { address: "w@wren.com", at: "google" as const, for: ["default", "signup"] };
const DAY = 86_400_000;
const now = Date.parse("2026-11-10T00:00:00.000Z");
const at = (days: number) => new Date(now + days * DAY).toISOString();
const kept = (name: string, expiresAt: string | null) => ({ name, updatedAt: null, expiresAt });

describe("token renewal", () => {
  it("finds what lapses within 14 days as the step and account that made it", () => {
    const plan = renewals(
      [linkedin, youtube, npm],
      [wren],
      [
        kept("LINKEDIN_ACCESS_TOKEN__W_WREN_COM", at(5)),
        kept("NPM_TOKEN", at(-1)),
        kept("YOUTUBE_REFRESH_TOKEN", null),
        kept("LINKEDIN_CLIENT_ID", null),
        kept("LINKEDIN_ACCESS_TOKEN__SOMEONE_ELSE_COM", at(3)),
        kept("OTHER_TOKEN", at(2)),
      ],
      14 * DAY,
      now,
    );
    // Soonest first; an expired one is due too.
    expect(plan.due.map((r) => [r.site, r.step, r.account])).toEqual([
      ["npm", "token", null],
      ["linkedin", "consent", "w@wren.com"],
    ]);
    // Never guessed: an account no identity names, a name no step makes.
    expect(plan.unplaced).toEqual(["OTHER_TOKEN", "LINKEDIN_ACCESS_TOKEN__SOMEONE_ELSE_COM"]);
    expect(renewWording(plan, null)[1]).toBe(
      `due: linkedin consent as w***@wren.com (lapses ${at(5)})`,
    );
  });
  it("one run covers a token kept under the site's own name and the policy account's", () => {
    const plan = renewals(
      [linkedin],
      [wren],
      [kept("LINKEDIN_ACCESS_TOKEN", at(1)), kept("LINKEDIN_ACCESS_TOKEN__W_WREN_COM", at(1))],
      14 * DAY,
      now,
    );
    expect(plan.due.map((r) => r.account)).toEqual([null]);
  });
  it("a consent keeps its lapse date, and renewal makes the token again as the same account", async () => {
    const port = 9417;
    let minted = 0;
    const api = fakeFetch(() => ({
      body: { access_token: `at-${++minted}`, expires_in: 60 * 86_400 },
    }));
    const env: Record<string, string> = { LINKEDIN_CLIENT_ID: "cid", LINKEDIN_CLIENT_SECRET: "cs" };
    const sink = memorySink();
    const browser = fakeBrowser([]);
    const asked: unknown[] = [];
    browser.on(linkedinOauthConsent, async (input) => {
      asked.push(input.account);
      const u = new URL(input.url);
      await fetch(
        `http://127.0.0.1:${port}/oauth/callback?code=c&state=${u.searchParams.get("state")}`,
      );
      return { landed: "" };
    });
    const sites = siteFacade([linkedin], {
      http: httpClient({ fetch: api.fetch }),
      env: (n) => env[n],
      sink,
      runner: browser,
      flow: (name) => (name === "linkedin/oauth-consent" ? linkedinOauthConsent : null),
      oauthPort: port,
      now: () => now,
    });
    await sites.setup("linkedin", "consent", "w@wren.com");
    const name = "LINKEDIN_ACCESS_TOKEN__W_WREN_COM";
    expect(sink.expires[name]).toBe(at(60));
    // 50 days on, it is due; the renewal runs the consent as the same account.
    const plan = renewals(
      [linkedin],
      [wren],
      [kept(name, sink.expires[name] ?? null)],
      14 * DAY,
      now + 50 * DAY,
    );
    const results = await renewDue(sites, plan);
    expect(results.map((r) => r.ok)).toEqual([true]);
    expect(asked).toEqual(["w@wren.com", "w@wren.com"]);
    expect(sink.values[name]).toBe("at-2");
    // The next look: the soonest lapse a step makes again, never a name nothing makes.
    expect(nextLapse([linkedin], [wren], [kept(name, at(60)), kept("OTHER_TOKEN", at(1))])).toBe(
      at(60),
    );
  });
  it("a failing renewal is said, and the rest still run", async () => {
    const sites = siteFacade([linkedin, npm], {
      http: httpClient({ fetch: fakeFetch(() => ({ body: {} })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: fakeBrowser([]),
      flow: () => null,
    });
    const plan = renewals(
      [linkedin, npm],
      [wren],
      [kept("LINKEDIN_ACCESS_TOKEN__W_WREN_COM", at(1)), kept("NPM_TOKEN", at(2))],
      14 * DAY,
      now,
    );
    const results = await renewDue(sites, plan);
    expect(results.map((r) => r.ok)).toEqual([false, false]);
    expect(renewWording(plan, results)[0]).toMatch(
      /^could not renew linkedin consent as w\*\*\*@wren.com .*: consent needs LINKEDIN_CLIENT_ID/,
    );
  });
});
