import { describe, expect, it } from "vitest";
import { LINKEDIN_LOGIN_URL, signInToLinkedin } from "../src/auth/linkedin.js";
import type { CodeKind, SignInContext } from "../src/auth/login.js";
import { SITE_LOGINS } from "../src/auth/sites.js";
import { linkedinOauthConsent } from "../src/browser/flows/linkedin-oauth-consent.js";
import type { Hints } from "../src/browser/locate.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { linkedinOAuth } from "../src/sites/linkedin.js";
import { fakePage } from "./auth-fakes.js";

const base = { username: "w@x.com", password: "p", recoveryCodes: [], passkeys: [] };
const ctx = (fp: SignInContext["fp"], kinds: CodeKind[]): SignInContext => ({
  fp,
  cred: base,
  code: async (kind) => (kinds.includes(kind) ? "123456" : Promise.reject(new Error("none"))),
  offers: (kind) => kinds.includes(kind),
  inbox: () => null,
  credFor: async () => base,
  as: () => ctx(fp, kinds),
});
const line = (a: { op: { kind: string }; hints: Hints }) =>
  `${a.op.kind} ${a.hints.name ?? a.hints.text}`;

describe("linkedin sign-in", () => {
  it("is a site login whose signInHere covers /login, /uas/login and checkpoints", () => {
    const login = SITE_LOGINS.find((l) => l.site === "linkedin");
    expect(login?.signInHere?.at).toBe(LINKEDIN_LOGIN_URL);
    for (const u of [
      "https://www.linkedin.com/login",
      "https://www.linkedin.com/uas/login?session_redirect=%2Foauth%2Fv2%2Fauthorization",
      "https://www.linkedin.com/checkpoint/challenge/abc",
    ])
      expect(LINKEDIN_LOGIN_URL.test(u)).toBe(true);
    expect(LINKEDIN_LOGIN_URL.test("https://www.linkedin.com/feed/")).toBe(false);
    expect(LINKEDIN_LOGIN_URL.test("https://www.linkedin.com/oauth/v2/authorization?x")).toBe(
      false,
    );
  });

  it("email, password, then the authenticator code at the checkpoint", async () => {
    let url = "https://www.linkedin.com/uas/login?session_redirect=%2Foauth";
    const { fp, acts } = fakePage({
      text: ["Sign in Email or phone Password", "Enter the code from your authenticator app"],
      present: () => true,
      url: () => url,
      onAct: (n) => {
        if (n === 3) url = "https://www.linkedin.com/checkpoint/challenge/1";
        if (n === 5) url = "https://www.linkedin.com/oauth/v2/authorization?client_id=1";
      },
    });
    await signInToLinkedin(ctx(fp, ["totp"]));
    expect(acts.map(line)).toEqual([
      "fill /email or phone/i",
      "fill /^password$/i",
      "click /^sign in$/i",
      "fill /code/i",
      "click /^(submit|verify|continue)$/i",
    ]);
  });

  it("falls back to the email code, and stops on a rejected password or a puzzle", async () => {
    let url = "https://www.linkedin.com/login";
    const emailed = fakePage({
      text: ["Sign in Email or phone Password", "We sent a verification code to your email"],
      present: () => true,
      url: () => url,
      onAct: (n) => {
        if (n === 5) url = "https://www.linkedin.com/feed/";
      },
    });
    await signInToLinkedin(ctx(emailed.fp, ["email"]));
    expect(emailed.acts[3]?.op).toMatchObject({ kind: "fill", value: "123456" });

    const noSeed = fakePage({
      text: ["Sign in Email or phone Password", "Enter the code from your authenticator app"],
      present: () => true,
      url: "https://www.linkedin.com/checkpoint/challenge/3",
    });
    await expect(signInToLinkedin(ctx(noSeed.fp, ["email"]))).rejects.toThrow(
      /totp code; store totpSecret/,
    );

    const rejected = fakePage({
      text: ["Sign in Email or phone Password", "Wrong email or password. Try again"],
      present: () => true,
    });
    await expect(signInToLinkedin(ctx(rejected.fp, []))).rejects.toThrow(/password rejected/);

    const puzzle = fakePage({
      text: ["Sign in Email or phone Password", "Let's do a quick security check puzzle"],
      present: (h) => !/code/i.test(String(h.name)),
      url: "https://www.linkedin.com/checkpoint/challenge/2",
    });
    await expect(signInToLinkedin(ctx(puzzle.fp, ["totp"]))).rejects.toThrow(
      /security check: fake/,
    );
  });

  it("solves the security check, then stops on a restricted account", async () => {
    let url = "https://www.linkedin.com/login/";
    const { fp } = fakePage({
      text: ["Let's do a quick security check"],
      present: () => false,
      url: () => url,
    });
    let solved = 0;
    fp.captcha = async () => {
      solved++;
      url = "https://www.linkedin.com/flagship-web/login/login-restriction/";
      return { solved: true, kind: "checkbox", vendor: "recaptcha", rounds: 1 };
    };
    await expect(signInToLinkedin(ctx(fp, []))).rejects.toThrow(/account restricted/);
    expect(solved).toBe(1);
  });
});

describe("linkedin/oauth-consent", () => {
  const authorize =
    "https://www.linkedin.com/oauth/v2/authorization?client_id=1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcb&state=s";

  it("is the site's consent leg and a catalogued flow", () => {
    expect(linkedinOAuth.consent).toEqual({ flow: "linkedin/oauth-consent" });
    expect(BROWSER_FLOWS["linkedin/oauth-consent"]).toBe(linkedinOauthConsent);
  });

  it("opens the feed, then the authorize URL, presses Allow and lands", async () => {
    let url = "https://www.linkedin.com/feed/";
    const opened: string[] = [];
    const { fp, acts } = fakePage({
      text: ["new-tool would like to access some of your LinkedIn info"],
      present: (h) => /allow/.test(String(h.name)),
      url: () => url,
      onAct: () => {
        url = "http://127.0.0.1:9876/cb?code=abc&state=s";
      },
    });
    fp.open = async (u) => {
      opened.push(u);
      url = u;
    };
    const out = await linkedinOauthConsent.run(fp, { url: authorize });
    expect(opened).toEqual(["https://www.linkedin.com/feed/", authorize]);
    expect(acts.map(line)).toEqual(["click /^(allow|continue)$/i"]);
    expect(out.landed).toMatch(/^http:\/\/127\.0\.0\.1:9876\/cb\?code=abc/);
  });

  it("re-opens the authorize URL without allowWall when LinkedIn shows its login under it", async () => {
    let url = "https://www.linkedin.com/feed/";
    const opens: Array<{ url: string; allowWall: boolean }> = [];
    const { fp } = fakePage({
      text: ["new-tool would like to access"],
      present: (h) => /allow/.test(String(h.name)),
      url: () => url,
      onAct: () => {
        url = "http://127.0.0.1:9876/cb?code=abc&state=s";
      },
    });
    fp.open = async (u, o) => {
      opens.push({ url: u, allowWall: Boolean(o?.allowWall) });
      // The first authorize open lands on the login page; the runner's sign-in (second open) does not.
      url = opens.length === 2 ? "https://www.linkedin.com/uas/login?session_redirect=x" : u;
    };
    await linkedinOauthConsent.run(fp, { url: authorize });
    expect(opens.map((o) => o.allowWall)).toEqual([false, true, false]);
  });

  it("hands a refusal to a person", async () => {
    const { fp } = fakePage({
      text: ["Bummer, something went wrong: invalid redirect_uri"],
      present: () => false,
      url: authorize,
    });
    fp.open = async () => {};
    await expect(linkedinOauthConsent.run(fp, { url: authorize })).rejects.toThrow(/refused/);
  });
});
