import { describe, expect, it } from "vitest";
import { signInToGithub } from "../src/auth/github.js";
import type { CodeKind, SignInContext } from "../src/auth/login.js";
import { isProvider, providerOf } from "../src/auth/providers.js";
import type { Hints } from "../src/browser/locate.js";
import { fakePage } from "./auth-fakes.js";

const base = { username: "octo", password: "p", recoveryCodes: [], passkeys: [] };
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

describe("github provider", () => {
  it("is registered with its button readings", () => {
    expect(isProvider("github")).toBe(true);
    const p = providerOf("github");
    expect(p.host.test("https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize")).toBe(
      true,
    );
    expect(p.host.test("https://github.com/octo/repo")).toBe(false);
    expect(
      p.buttons.some((b) => b.text === "/(continue|sign ?in|log ?in|sign ?up) with github/i"),
    ).toBe(true);
  });

  it("password, authenticator code, then the app's authorize page", async () => {
    let url = "https://github.com/login?return_to=x";
    const { fp, acts } = fakePage({
      text: [
        "Sign in to GitHub Username or email address Password",
        "Two-factor authentication Authentication code",
        "Authorize new-tool",
      ],
      present: (h) => !/verify/i.test(String(h.name)),
      url: () => url,
      onAct: (n) => {
        if (n === 3) url = "https://github.com/sessions/two-factor/app";
        if (n === 4) url = "https://github.com/login/oauth/authorize?client_id=1";
      },
    });
    await signInToGithub(ctx(fp, ["totp"]));
    expect(acts.map(line)).toEqual([
      "fill /username or email/i",
      "fill /^password$/i",
      "click /^sign in$/i",
      "fill /authentication code|verification code|xxxxxx/i",
      "click /^authorize/i",
    ]);
  });

  it("stops on a rejected password and says what two-factor needs", async () => {
    const rejected = fakePage({
      text: ["Sign in", "Incorrect username or password."],
      present: () => true,
    });
    await expect(signInToGithub(ctx(rejected.fp, ["totp"]))).rejects.toThrow(/password rejected/);
    const noTotp = fakePage({
      text: ["Sign in", "Two-factor authentication Authentication code"],
      present: () => true,
      url: "https://github.com/sessions/two-factor/app",
    });
    await expect(signInToGithub(ctx(noTotp.fp, []))).rejects.toThrow(/store totpSecret/);
  });

  it("answers a device verification code from the inbox", async () => {
    let url = "https://github.com/sessions/verified-device";
    const { fp, acts } = fakePage({
      text: ["Sign in", "Device verification We just sent your authentication code", "Dashboard"],
      present: (h) => String(h.name) !== "/^verify$/i",
      url: () => url,
      onAct: (n) => {
        if (n === 4) url = "https://github.com/";
      },
    });
    await signInToGithub(ctx(fp, ["email"]));
    expect(acts.map(line).slice(3)).toEqual(["fill /verification code|device verification/i"]);
  });
});
