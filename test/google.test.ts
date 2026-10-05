import { describe, expect, it } from "vitest";
import type { Credential } from "../src/auth/credentials.js";
import { signInToGoogle } from "../src/auth/google.js";
import type { CodeKind, SignInContext } from "../src/auth/login.js";
import { fakeSite, type State } from "./site-fakes.js";

const ACCOUNTS = "https://accounts.google.com/v3/signin";
const base: Credential = {
  username: "u@gmail.com",
  password: "p",
  recoveryCodes: [],
  passkeys: [],
};

const ctxOf = (
  fp: SignInContext["fp"],
  kinds: CodeKind[],
  cred: Credential = base,
  notify?: (t: string) => Promise<void>,
): SignInContext => ({
  fp,
  cred,
  code: async (kind) => (kinds.includes(kind) ? "123456" : Promise.reject(new Error("none"))),
  offers: (kind) => kinds.includes(kind),
  inbox: (kind) => (kind === "sms" && kinds.includes(kind) ? "+15555550182" : null),
  ...(notify ? { notify } : {}),
  credFor: async () => cred,
  as: (c) => ctxOf(fp, kinds, c, notify),
});

/** The pages every sign-in shares: the site after, the email box, the password box. */
const site: State = { url: "https://site.test/home", has: [] };
const email: State = {
  url: `${ACCOUNTS}/identifier?x`,
  text: "Sign in Email or phone",
  has: ["textbox:Email or phone", "button:Next"],
  on: { "click button:Next": "pwd" },
};
const pwd = (next: string): State => ({
  url: `${ACCOUNTS}/challenge/pwd?x`,
  text: "Hi u@gmail.com Enter your password",
  has: ["textbox:Password", "button:Next"],
  on: { "click button:Next": next },
});
const selection = (has: string[], on: Record<string, string> = {}, text?: string): State => ({
  url: `${ACCOUNTS}/challenge/selection?x`,
  text: text ?? "2-Step Verification Choose how you want to sign in",
  has,
  on,
});
const totp: State = {
  url: `${ACCOUNTS}/challenge/totp?x`,
  text: "2-Step Verification Get a verification code from the Google Authenticator app",
  has: ["textbox:Enter code", "button:Next"],
  on: { "click button:Next": "site" },
};
const smsCode: State = {
  url: `${ACCOUNTS}/challenge/ipp?x`,
  text: "2-Step Verification Enter the code",
  has: ["textbox:Enter the code", "button:Next"],
  on: { "click button:Next": "site" },
};

describe("Google sign-in walk", () => {
  it("email, password, authenticator code, then the site", async () => {
    const s = fakeSite({ email, pwd: pwd("totp"), totp, site }, "email");
    await signInToGoogle(ctxOf(s.fp, ["totp"]));
    expect(s.acts).toEqual([
      "fill Email or phone=u@gmail.com",
      "click Next",
      "fill Password=p",
      "click Next",
      "fill Enter code=123456",
      "click Next",
    ]);
    expect(s.at()).toBe("site");
  });

  it("continues past the OAuth consent page, twice at most", async () => {
    const consent = (next: string): State => ({
      url: "https://accounts.google.com/signin/oauth/id?authuser=0",
      text: "Loading",
      has: ["button:Continue"],
      on: { "click button:Continue": next },
    });
    const s = fakeSite({ c1: consent("c2"), c2: consent("site"), site }, "c1");
    await signInToGoogle(ctxOf(s.fp, ["totp"]));
    expect(s.acts).toEqual(["click Continue", "click Continue"]);
  });

  it("ends on a scope grant: signed in, the consent's flow clicks Allow", async () => {
    const s = fakeSite(
      {
        pwd: pwd("grant"),
        grant: {
          url: "https://accounts.google.com/signin/oauth/v3/consent?x",
          text: "Google Cloud SDK wants access to your Google Account",
          has: ["button:Allow", "button:Cancel"],
        },
      },
      "pwd",
    );
    await signInToGoogle(ctxOf(s.fp, ["totp"]));
    expect(s.acts).toEqual(["fill Password=p", "click Next"]);
    expect(s.at()).toBe("grant");
  });

  it("switches account when the profile is signed in as someone else", async () => {
    const s = fakeSite(
      {
        other: {
          url: `${ACCOUNTS}/challenge/pwd?x`,
          text: "Hi Other other@gmail.com Enter your password other@gmail.com selected. Switch account",
          has: ["textbox:Password", "button:Next", "link:Switch account"],
          on: { "click link:Switch account": "chooser" },
        },
        chooser: {
          url: `${ACCOUNTS}/accountchooser?x`,
          text: "Choose an account other@gmail.com Use another account",
          has: ["text:other@gmail.com", "text:Use another account"],
          on: { "click text:Use another account": "email" },
        },
        email,
        pwd: pwd("site"),
        site,
      },
      "other",
    );
    await signInToGoogle(ctxOf(s.fp, ["totp"]));
    expect(s.acts).toEqual([
      "click Switch account",
      "click Use another account",
      "fill Email or phone=u@gmail.com",
      "click Next",
      "fill Password=p",
      "click Next",
    ]);
  });

  it("picks the account from the chooser when it is there", async () => {
    const s = fakeSite(
      {
        chooser: {
          url: `${ACCOUNTS}/accountchooser?x`,
          text: "Choose an account u@gmail.com other@gmail.com Use another account",
          has: ["text:u@gmail.com", "text:other@gmail.com", "text:Use another account"],
          on: { "click text:u@gmail.com": "pwd" },
        },
        pwd: pwd("site"),
        site,
      },
      "chooser",
    );
    await signInToGoogle(ctxOf(s.fp, ["totp"]));
    expect(s.acts).toEqual(["click u@gmail.com", "fill Password=p", "click Next"]);
  });

  it("One Tap: the account, then the confirm; never a password", async () => {
    const s = fakeSite(
      {
        card: {
          url: "https://accounts.google.com/gsi/select?client_id=1",
          has: ["text:u@gmail.com"],
          on: { "click text:u@gmail.com": "confirm" },
        },
        confirm: {
          url: "https://accounts.google.com/gsi/select?client_id=1",
          has: ["css:#confirm_yes"],
          on: { "click css:#confirm_yes": "site" },
        },
        site,
      },
      "card",
    );
    await signInToGoogle(ctxOf(s.fp, []));
    expect(s.acts).toEqual(["click u@gmail.com", "click #confirm_yes"]);
  });

  it("asks for the SMS from the list when a phone can read it", async () => {
    const s = fakeSite(
      {
        list: selection(
          ["link:Get a verification code at (•••) •••-••82", "link:Tap Yes on your phone"],
          { "click link:Get a verification code at (•••) •••-••82": "code" },
        ),
        code: smsCode,
        site,
      },
      "list",
    );
    await signInToGoogle(ctxOf(s.fp, ["sms"]));
    expect(s.acts).toEqual([
      "click Get a verification code at (•••) •••-••82",
      "fill Enter the code=123456",
      "click Next",
    ]);
  });

  it("a page asking for a phone gets ours, then the code", async () => {
    const s = fakeSite(
      {
        phone: {
          url: `${ACCOUNTS}/challenge/ipp?x`,
          text: "Enter a phone number to get a text message with a verification code",
          has: ["textbox:Phone number", "button:Next"],
          on: { "click button:Next": "code" },
        },
        code: smsCode,
        site,
      },
      "phone",
    );
    await signInToGoogle(ctxOf(s.fp, ["sms"]));
    expect(s.acts).toEqual([
      "fill Phone number=+15555550182",
      "click Next",
      "fill Enter the code=123456",
      "click Next",
    ]);
  });

  it("too many failed attempts ends the sign-in with a plain reason, no guess", async () => {
    const s = fakeSite(
      {
        list: selection([
          "link:Get a verification code at (•••) •••-••82",
          "text:Too many failed attempts",
        ]),
      },
      "list",
    );
    await expect(signInToGoogle(ctxOf(s.fp, ["sms"]))).rejects.toThrow(/try again in a few hours/);
    expect(s.acts).toEqual([]);
  });

  it("pings the phone for a Tap Yes when only a phone is linked", async () => {
    const notes: string[] = [];
    const s = fakeSite(
      {
        list: selection(["link:Tap Yes on your phone"], {
          "click link:Tap Yes on your phone": "prompt",
        }),
        // The Yes lands the site; the page said where the prompt went.
        prompt: { url: "https://site.test/home", text: "Open the YouTube app on Apple iPhone 12" },
      },
      "list",
    );
    await signInToGoogle(
      ctxOf(s.fp, [], base, async (t) => {
        notes.push(t);
      }),
    );
    expect(s.acts).toEqual(["click Tap Yes on your phone"]);
    expect(notes[0]).toMatch(/Open the YouTube app on Apple iPhone 12 and tap Yes/);
  });

  it("says what to set up when nothing can answer", async () => {
    const s = fakeSite({ list: selection(["link:Tap Yes on your phone"]) }, "list");
    await expect(signInToGoogle(ctxOf(s.fp, []))).rejects.toThrow(/enroll TOTP, link a phone/);
  });

  it("a passkey prompt after the password goes to the other steps, then the authenticator", async () => {
    const s = fakeSite(
      {
        pwd: pwd("pk"),
        pk: {
          url: `${ACCOUNTS}/challenge/pk/presend?x`,
          text: "Use your passkey to confirm it's really you More ways to verify",
          has: ["button:More ways to verify"],
          on: { "click button:More ways to verify": "list" },
        },
        list: selection(["link:Get a verification code from the Google Authenticator app"], {
          "click link:Get a verification code from the Google Authenticator app": "totp",
        }),
        totp,
        site,
      },
      "pwd",
    );
    await signInToGoogle(ctxOf(s.fp, ["totp"]));
    expect(s.acts).toEqual([
      "fill Password=p",
      "click Next",
      "click More ways to verify",
      "click Get a verification code from the Google Authenticator app",
      "fill Enter code=123456",
      "click Next",
    ]);
  });

  it("a passkey asked before the password: the list offers the password", async () => {
    const s = fakeSite(
      {
        pk: {
          url: `${ACCOUNTS}/challenge/pk?x`,
          text: "Verifying it's you Complete sign-in using your passkey Try another way",
          has: ["button:Try another way"],
          on: { "click button:Try another way": "list" },
        },
        list: selection(["link:Enter your password", "link:Tap Yes on your phone"], {
          "click link:Enter your password": "pwd",
        }),
        pwd: pwd("site"),
        site,
      },
      "pk",
    );
    await signInToGoogle(ctxOf(s.fp, ["totp"]));
    expect(s.acts).toEqual([
      "click Try another way",
      "click Enter your password",
      "fill Password=p",
      "click Next",
    ]);
  });

  it("a passkey we hold answers first; when Google refuses it the error says so", async () => {
    const pk = {
      rpId: "google.com",
      credentialId: "c",
      privateKey: "k",
      signCount: 1,
      isResidentCredential: true,
    };
    const s = fakeSite(
      {
        list: selection(
          ["link:Use your passkey"],
          { "click link:Use your passkey": "presend" },
          "u@gmail.com Verify it's you Choose a way to verify",
        ),
        presend: {
          url: `${ACCOUNTS}/challenge/pk/presend?x`,
          text: "Your device will ask for your fingerprint",
          has: ["button:Continue"],
          on: { "click button:Continue": "error" },
        },
        // The ceremony never leaves the challenge: Google did not recognise the passkey.
        error: {
          url: `${ACCOUNTS}/challenge/pk/error?x`,
          text: "Something went wrong Try another way",
          has: ["button:Try another way"],
          on: { "click button:Try another way": "again" },
        },
        again: selection(["link:Tap Yes on your phone"], {}, "Choose a way to verify"),
      },
      "list",
    );
    await expect(
      signInToGoogle(ctxOf(s.fp, ["totp"], { ...base, passkeys: [pk] })),
    ).rejects.toThrow(/does not offer the authenticator app here; our passkey was refused/);
    expect(s.acts).toEqual(["click Use your passkey", "click Continue", "click Try another way"]);
  });

  it("the previous password once after a rotation the site took quietly; else rejected", async () => {
    const wrong: State = {
      url: `${ACCOUNTS}/challenge/pwd?x`,
      text: "Hi u@gmail.com Wrong password. Try again",
      has: ["textbox:Password", "button:Next"],
      on: { "click button:Next": "site" },
    };
    const s = fakeSite({ pwd: pwd("wrong"), wrong, site }, "pwd");
    await signInToGoogle(ctxOf(s.fp, [], { ...base, previousPassword: "old" }));
    expect(s.acts).toEqual(["fill Password=p", "click Next", "fill Password=old", "click Next"]);
    const t = fakeSite({ pwd: pwd("wrong"), wrong: { ...wrong, on: {} }, site }, "pwd");
    await expect(signInToGoogle(ctxOf(t.fp, []))).rejects.toThrow(/password rejected/);
  });

  it("an unknown address, a refused browser, and a step nothing can answer each fail plainly", async () => {
    const nope = fakeSite(
      {
        email: { ...email, on: { "click button:Next": "no" } },
        no: { ...email, text: "Couldn't find your Google Account" },
      },
      "email",
    );
    await expect(signInToGoogle(ctxOf(nope.fp, []))).rejects.toThrow(/unknown account/);
    const refused = fakeSite(
      {
        r: {
          url: `${ACCOUNTS}/rejected?x`,
          text: "This browser or app may not be secure",
          has: [],
        },
      },
      "r",
    );
    await expect(signInToGoogle(ctxOf(refused.fp, []))).rejects.toThrow(/refused this browser/);
    const recovery = fakeSite(
      {
        r: {
          url: `${ACCOUNTS}/challenge/kpe?x`,
          text: "Verify it's you Confirm your recovery email",
          has: ["textbox:Recovery email", "button:Next"],
        },
      },
      "r",
    );
    await expect(signInToGoogle(ctxOf(recovery.fp, ["totp"]))).rejects.toThrow(
      /second step this tool cannot answer/,
    );
  });

  it("a new Workspace account's terms are accepted on the way", async () => {
    const s = fakeSite(
      {
        pwd: pwd("terms"),
        terms: {
          url: "https://accounts.google.com/speedbump/gaplustos?x",
          text: "Welcome to your new account",
          has: ["button:I understand"],
          on: { "click button:I understand": "site" },
        },
        site,
      },
      "pwd",
    );
    await signInToGoogle(ctxOf(s.fp, []));
    expect(s.acts).toEqual(["fill Password=p", "click Next", "click I understand"]);
  });

  it("a page no screen knows fails as LoginFailed, so the next method gets its turn", async () => {
    const s = fakeSite(
      {
        odd: {
          url: `${ACCOUNTS}/somethingnew?x`,
          text: "A new page",
          has: ["button:Whatever"],
        },
      },
      "odd",
    );
    await expect(signInToGoogle(ctxOf(s.fp, []))).rejects.toThrow(/sign-in does not know/);
    expect(s.acts).toEqual([]);
  });
});
