import { describe, expect, it } from "vitest";
import type { CodeKind, SignInContext } from "../src/auth/login.js";
import { signInToMicrosoft } from "../src/auth/microsoft.js";
import { isProvider, providerOf } from "../src/auth/providers.js";
import { fakeSite, type State } from "./site-fakes.js";

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
const MS = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x";

describe("microsoft provider", () => {
  it("is registered with its button readings", () => {
    expect(isProvider("microsoft")).toBe(true);
    const p = providerOf("microsoft");
    expect(p.host.test(MS)).toBe(true);
    expect(p.host.test("https://login.live.com/oauth20_authorize.srf")).toBe(true);
    expect(p.host.test("https://site.test/dashboard")).toBe(false);
  });

  const email: State = {
    url: MS,
    has: ["textbox:Email, phone, or Skype", "button:Next"],
    text: "Sign in",
    on: { "click button:Next": "password" },
  };
  const password = (next: string): State => ({
    url: MS,
    has: ["textbox:Password", "button:Sign in"],
    text: "Enter password",
    on: { "click button:Sign in": next },
  });
  const home: State = { url: "https://site.test/home", has: [], text: "Welcome" };

  it("email, password, authenticator code, stay signed in, accept permissions", async () => {
    const site = fakeSite(
      {
        email,
        password: password("code"),
        code: {
          url: MS,
          has: ["textbox:Code", "button:Verify"],
          text: "Verify your identity Enter code",
          on: { "click button:Verify": "kmsi" },
        },
        kmsi: {
          url: MS,
          has: ["button:Yes", "button:No"],
          text: "Stay signed in?",
          on: { "click button:Yes": "consent" },
        },
        consent: {
          url: MS,
          has: ["button:Accept", "button:Cancel"],
          text: "Permissions requested",
          on: { "click button:Accept": "home" },
        },
        home,
      },
      "email",
    );
    await signInToMicrosoft(ctx(site.fp, ["totp"]));
    expect(site.acts).toEqual([
      "fill Email, phone, or Skype=w@wren.test",
      "click Next",
      "fill Password=p",
      "click Sign in",
      "fill Code=123456",
      "click Verify",
      "click Yes",
      "click Accept",
    ]);
  });

  it("asks the phone to approve when no code source exists, and names the number", async () => {
    const notes: string[] = [];
    const site = fakeSite(
      {
        email,
        password: password("approve"),
        approve: {
          url: MS,
          has: [],
          text: "Approve sign in request Open your Authenticator app, and enter the number shown to sign in. 42",
        },
        home,
      },
      "email",
    );
    await signInToMicrosoft(
      ctx(site.fp, [], async (t) => {
        notes.push(t);
        site.go("home");
      }),
    );
    expect(notes[0]).toMatch(/approve it in the Authenticator app \(number 42\)/);
    expect(site.acts).toHaveLength(4);
  });

  it("stops on a rejected password or an unknown account", async () => {
    const wrong = fakeSite(
      {
        email,
        password: password("wrong"),
        wrong: {
          url: MS,
          has: ["textbox:Password"],
          text: "Your account or password is incorrect.",
        },
      },
      "email",
    );
    await expect(signInToMicrosoft(ctx(wrong.fp, []))).rejects.toThrow(/password rejected/);
    const unknown = fakeSite(
      {
        email: { ...email, on: { "click button:Next": "unknown" } },
        unknown: { url: MS, has: [], text: "We couldn't find an account with that username." },
      },
      "email",
    );
    await expect(signInToMicrosoft(ctx(unknown.fp, []))).rejects.toThrow(/unknown account/);
  });
});
