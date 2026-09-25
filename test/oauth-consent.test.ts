import { describe, expect, it } from "vitest";
import type { FlowPage } from "../src/browser/flow.js";
import { googleOauthConsent, redirectOf } from "../src/browser/flows/oauth-consent.js";
import type { Hints } from "../src/browser/locate.js";
import { NeedsHuman } from "../src/browser/session.js";
import { codeFrom } from "../src/sites/oauth.js";

const AUTH =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A9400%2Foauth%2Fcallback&scope=x&state=s";

/** The consent as pages: each has a url, text, and which hints are present; a click moves to the next. */
function consentPages(
  pages: Array<{ url: string; text?: string; present?: (h: Hints) => boolean }>,
) {
  let i = 0;
  let ticked = false;
  const acts: string[] = [];
  const page = () => pages[Math.min(i, pages.length - 1)] as (typeof pages)[number];
  const fp: FlowPage = {
    captcha: async () => ({ solved: false, kind: null, vendor: null, reason: "fake" }),
    page: {} as FlowPage["page"],
    async open() {},
    url: () => page().url,
    text: async () => page().text ?? "",
    html: async () => "",
    has: async (h) =>
      h.css?.includes("aria-checked") && ticked ? false : (page().present?.(h) ?? false),
    wait: async () => {},
    answer: async () => {},
    waitForUrl: async () => true,
    nextPage: async () => null,
    pages: () => [],
    switchTo() {},
    async act(_op, _hints, o) {
      const goal = o?.goal ?? "";
      acts.push(goal);
      // Advanced and the scope boxes change the page in place; everything else moves on.
      if (goal === "advanced") return;
      if (goal === "select all scopes" || goal === "grant a scope") {
        ticked = true;
        return;
      }
      i++;
    },
    async signIn() {
      return "no-login" as const;
    },
    human(reason) {
      throw new NeedsHuman(reason);
    },
  };
  return { fp, acts };
}

describe("the code from the landed url", () => {
  const r = "https://localhost:9400/oauth/callback";
  it("reads the code; refuses another state or a refusal; ignores another page", () => {
    expect(codeFrom(`${r}?code=c&state=s#_=_`, r, "s")).toBe("c");
    expect(codeFrom("https://www.facebook.com/dialog", r, "s")).toBeNull();
    expect(() => codeFrom(`${r}?code=c&state=x`, r, "s")).toThrow(/state/);
    expect(() => codeFrom(`${r}?error=access_denied&state=s`, r, "s")).toThrow(/access_denied/);
  });
});

describe("google oauth consent", () => {
  it("reads the redirect off the authorize url", () => {
    expect(redirectOf(AUTH)).toBe("http://127.0.0.1:9400/oauth/callback");
    expect(() => redirectOf("https://x.test/?a=1")).toThrow(/redirect_uri/);
  });

  it("walks chooser, unverified-app warning, scope boxes and continue until the redirect", async () => {
    const { fp, acts } = consentPages([
      { url: AUTH, text: "Choose an account", present: (h) => h.css === "[data-identifier]" },
      {
        url: "https://accounts.google.com/signin/oauth/warning",
        text: "Google hasn't verified this app",
        present: (h) => h.name === "/^advanced$/i" || Boolean(h.css?.includes("unsafe")),
      },
      {
        url: "https://accounts.google.com/signin/oauth/consent",
        text: "Wren Automation wants access",
        present: (h) =>
          Boolean(h.css?.includes("aria-checked")) || h.name === "/^(continue|allow|confirm)$/i",
      },
      { url: "http://127.0.0.1:9400/oauth/callback?code=abc&state=s" },
    ]);
    const out = await googleOauthConsent.run(fp, { url: AUTH });
    expect(out.landed).toMatch(/^http:\/\/127\.0\.0\.1:9400\/oauth\/callback/);
    expect(acts).toEqual([
      "pick the account",
      "advanced",
      "past the unverified-app warning",
      "select all scopes",
      "consent",
    ]);
  });

  it("hands over when Google refuses or the walk goes nowhere", async () => {
    const refused = consentPages([{ url: AUTH, text: "Error 400: redirect_uri_mismatch" }]);
    await expect(googleOauthConsent.run(refused.fp, { url: AUTH })).rejects.toThrow(/refused/);
    const stuck = consentPages([{ url: AUTH, text: "Loading" }]);
    await expect(googleOauthConsent.run(stuck.fp, { url: AUTH })).rejects.toThrow(/still on/);
  });
});
