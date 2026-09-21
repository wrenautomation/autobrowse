import { describe, expect, it } from "vitest";
import type { CodeKind, SignInContext } from "../src/auth/login.js";
import { signInToMicrosoft } from "../src/auth/microsoft.js";
import { isProvider, providerOf } from "../src/auth/providers.js";
import type { Hints } from "../src/browser/locate.js";
import { fakePage } from "./auth-fakes.js";

const base = { username: "w@wren.test", password: "p", recoveryCodes: [], passkeys: [] };
const ctx = (
  fp: SignInContext["fp"],
  kinds: CodeKind[],
  notify?: (t: string) => Promise<void>,
): SignInContext => ({
  fp,
  cred: base,
  code: async (kind) => (kinds.includes(kind) ? "123456" : Promise.reject(new Error("none"))),
  offers: (kind) => kinds.includes(kind),
  inbox: () => null,
  ...(notify ? { notify } : {}),
  credFor: async () => base,
  as: () => ctx(fp, kinds, notify),
});
const line = (a: { op: { kind: string }; hints: Hints }) =>
  `${a.op.kind} ${a.hints.name ?? a.hints.text}`;
const MS = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x";

describe("microsoft provider", () => {
  it("is registered with its button readings", () => {
    expect(isProvider("microsoft")).toBe(true);
    const p = providerOf("microsoft");
    expect(p.host.test(MS)).toBe(true);
    expect(p.host.test("https://login.live.com/oauth20_authorize.srf")).toBe(true);
    expect(p.host.test("https://site.test/dashboard")).toBe(false);
  });

  it("email, password, authenticator code, stay signed in, accept permissions", async () => {
    let url = MS;
    const { fp, acts } = fakePage({
      text: [
        "Sign in Email, phone, or Skype",
        "Enter password",
        "Verify your identity Enter code",
        "Stay signed in?",
        "Permissions requested",
        "Welcome",
      ],
      present: (h) => !/^\/password\/i$/.test(String(h.name)) || url === MS,
      url: () => url,
      onAct: (n) => {
        if (n === 8) url = "https://site.test/home";
      },
    });
    await signInToMicrosoft(ctx(fp, ["totp"]));
    expect(acts.map(line)).toEqual([
      "fill /email|phone|skype|sign in/i",
      "click /^next$/i",
      "fill /password/i",
      "click /^sign in$/i",
      "fill /code/i",
      "click /^verify$/i",
      "click /^yes$/i",
      "click /^accept$/i",
    ]);
  });

  it("asks the phone to approve when no code source exists, and names the number", async () => {
    let url = MS;
    const notes: string[] = [];
    const { fp, acts } = fakePage({
      text: [
        "Sign in",
        "Enter password",
        "Approve sign in request Open your Authenticator app, and enter the number shown to sign in. 42",
        "Welcome",
      ],
      present: (h) => !/code/i.test(String(h.name)),
      url: () => url,
      onAct: (n) => {
        if (n === 4) url = "https://site.test/home";
      },
    });
    await signInToMicrosoft(
      ctx(fp, [], async (t) => {
        notes.push(t);
      }),
    );
    expect(notes[0]).toMatch(/approve it in the Authenticator app \(number 42\)/);
    expect(acts.map(line)).toHaveLength(4);
  });

  it("stops on a rejected password or an unknown account", async () => {
    const wrong = fakePage({
      text: ["Sign in", "Enter password", "Your account or password is incorrect."],
      present: () => true,
      url: MS,
    });
    await expect(signInToMicrosoft(ctx(wrong.fp, []))).rejects.toThrow(/password rejected/);
    const unknown = fakePage({
      text: ["Sign in", "We couldn't find an account with that username."],
      present: () => true,
      url: MS,
    });
    await expect(signInToMicrosoft(ctx(unknown.fp, []))).rejects.toThrow(/unknown account/);
  });
});
