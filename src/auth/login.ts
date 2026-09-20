/**
 * Signing in as code. A `SiteLogin` knows one site's login page: how to
 * tell a signed-in page from a wall, and the gestures from the sign-in
 * button to the dashboard. Passwords come from the credential store,
 * second factors from the code sources; the flow only sees `fp.act`.
 *
 * `formLogin` covers the common shape (username, maybe a Next, password,
 * submit, maybe a code). Sites that differ write `signIn` by hand.
 */
import type { FlowPage } from "../browser/flow.js";
import type { Hints } from "../browser/locate.js";
import type { CodeKind, CodeSource } from "./codes.js";
import type { Credential, CredentialStore } from "./credentials.js";

export interface SignInContext {
  fp: FlowPage;
  cred: Credential;
  /** A second-factor code of this kind, or throws when none can be had. */
  code(kind: CodeKind, hint?: string): Promise<string>;
  /** Whether a code of this kind can be had, so the sign-in picks that step on the page. */
  offers(kind: CodeKind): boolean;
  /** Where that code would land, to match against a page that masks numbers ("•••-••82"). */
  inbox(kind: CodeKind): string | null;
  /**
   * A note to the person's phone, for a step only a device can answer
   * ("Tap Yes on your phone"). Absent when no phone is linked.
   */
  notify?: (text: string) => Promise<void>;
  /** Another site's credential (the identity provider behind an OAuth button), or throws. */
  credFor(site: string): Promise<Credential>;
}

export interface SiteLogin {
  site: string;
  home: string;
  /**
   * Which stored credential signs in here; default = `site`. Sites behind
   * the same identity provider name it once: `google` for the admin
   * console and for every "Sign in with Google" button.
   */
  credential?: string;
  /**
   * What setup says when it asks for this credential, in the site's own
   * terms ("A Google Workspace admin for your domains"). Default: the site name.
   */
  ask?: string;
  /** Identity providers whose button this site's `signIn` can use instead of a password. */
  via?: readonly ["google"];
  /** True when the page shows a signed-in state (avatar, dashboard, no sign-in form). */
  loggedIn(fp: FlowPage): Promise<boolean>;
  signIn(ctx: SignInContext): Promise<void>;
  /**
   * The site's own sign-in surface (accounts.google.com). A wall there is
   * answered where the page is: a security page asks for the password
   * again even though `home` is signed in, so `signIn` would find nothing to do.
   */
  signInHere?: { at: RegExp; run(ctx: SignInContext): Promise<void> };
  /** How this site's authenticator setup page walks, when it is known; `enroll-totp` guesses otherwise. */
  totpSetup?: TotpSetupSpec;
  /** How this site's change-password page walks, for `creds rotate`. */
  passwordChange?: PasswordChangeSpec;
  /** How this site's passkey page walks, for `enroll-passkey`. */
  passkeySetup?: PasskeySetupSpec;
}

/** The passkeys page: the button that starts the ceremony (our authenticator answers it), what the page says after. */
export interface PasskeySetupSpec {
  url: string | ((cred: Credential) => string);
  create: Hints;
  /** Confirmations after `create`, clicked when present ("Continue passkey enrollment"). */
  confirmations?: Hints[];
  done: RegExp;
}

/** The change-password page: fields to fill, the submit, what the page says after. */
export interface PasswordChangeSpec {
  url: string | ((cred: Credential) => string);
  /** The current password, when the page asks for it on the form itself. */
  current?: Hints;
  next: Hints;
  confirm?: Hints;
  submit: Hints;
  done: RegExp;
}

/** The clicks from the two-factor page to the seed, then to the code box. */
export interface TotpSetupSpec {
  /** The setup page; a function when the URL must name the account (Google's `authuser=`). */
  url: string | ((cred: Credential) => string);
  /** In order, until the seed is on the page ("Set up authenticator", "Can't scan it?"). */
  reveal: Hints[];
  /** From the seed to the code box ("Next"), if any. */
  toCode?: Hints[];
  code: Hints;
  confirm: Hints;
  /** Text that means the site accepted the code. */
  done: RegExp;
}

/** The step where a code is asked: which field, how to submit, what kind of code. */
export interface CodeStep {
  kind: CodeKind;
  field: Hints;
  submit: Hints;
  /** Text that says the page is asking for a code; absent = the field's presence decides. */
  asks?: RegExp;
  /** Something the message would contain, for email/SMS. */
  hint?: string;
}

export interface FormLoginSpec {
  start: string;
  username: Hints;
  /** Two-page forms: press this after the username. */
  next?: Hints;
  password: Hints;
  submit: Hints;
  code?: CodeStep;
  /** Signed in when the page text or URL matches; else when the password field is gone. */
  success?: RegExp;
  /** Text that means the password was rejected: stop, do not lock the account. */
  rejected?: RegExp;
}

export class LoginFailed extends Error {
  constructor(site: string, reason: string) {
    super(`${site}: ${reason}`);
    this.name = "LoginFailed";
  }
}

const SETTLE_MS = 1_500;
/** How long a sign-in page gets to render its next step before it counts as absent. */
const RENDER_MS = 8_000;
/** How long a person gets to tap Yes on their phone. */
const PROMPT_MS = 180_000;

export function formLogin(site: string, spec: FormLoginSpec): SiteLogin["signIn"] {
  return async ({ fp, cred, code }) => {
    await fp.open(spec.start, { allowWall: true });
    await fp.act({ kind: "fill", value: cred.username }, spec.username, { goal: "type username" });
    if (spec.next) await fp.act({ kind: "click" }, spec.next, { goal: "continue past username" });
    await fp.act({ kind: "fill", value: cred.password }, spec.password, { goal: "type password" });
    await fp.act({ kind: "click" }, spec.submit, { goal: "submit login form" });
    await fp.wait(SETTLE_MS);
    let text = await fp.text();
    if (spec.rejected?.test(text) && cred.previousPassword) {
      // A rotation the site took without saying so: the one before still works once.
      await fp.act({ kind: "fill", value: cred.previousPassword }, spec.password, {
        goal: "type the previous password",
      });
      await fp.act({ kind: "click" }, spec.submit, { goal: "submit login form" });
      await fp.wait(SETTLE_MS);
      text = await fp.text();
    }
    if (spec.rejected?.test(text)) throw new LoginFailed(site, "password rejected");
    if (spec.code && (spec.code.asks ? spec.code.asks.test(text) : await fp.has(spec.code.field))) {
      const c = await code(spec.code.kind, spec.code.hint);
      await fp.act({ kind: "fill", value: c }, spec.code.field, { goal: "type verification code" });
      await fp.act({ kind: "click" }, spec.code.submit, { goal: "submit verification code" });
      await fp.wait(SETTLE_MS);
      text = await fp.text();
    }
    const ok = spec.success
      ? spec.success.test(text) || spec.success.test(fp.url())
      : !(await fp.has(spec.password));
    if (!ok) throw new LoginFailed(site, `still on ${fp.url()} after sign-in`);
  };
}

/**
 * Google's own sign-in pages, wherever they appear: the admin console, or
 * the popup behind another site's "Google" button. Handles the account
 * chooser, the password page, and a TOTP challenge.
 */
export async function signInToGoogle(ctx: SignInContext): Promise<void> {
  const { fp, cred } = ctx;
  const site = "google";
  await fp.wait(SETTLE_MS);
  let text = await fp.text();
  // A profile already signed in as someone else: the page names that
  // account, with a link "<other> selected. Switch account".
  const switchLink = { role: "link", name: "/switch account/i" } as const;
  if (!text.toLowerCase().includes(cred.username.toLowerCase()) && (await fp.has(switchLink))) {
    await fp.act({ kind: "click" }, switchLink, { goal: `switch to ${cred.username}` });
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (/choose an account/i.test(text)) {
    if (await fp.has({ text: cred.username })) {
      await fp.act({ kind: "click" }, { text: cred.username }, { goal: "pick the account" });
    } else {
      await fp.act(
        { kind: "click" },
        { text: "/use another account/i" },
        { goal: "use another account" },
      );
      await fp.wait(SETTLE_MS);
      text = await fp.text();
    }
  }
  if (await fp.has({ role: "textbox", name: "/email or phone/i" }, RENDER_MS)) {
    await fp.act(
      { kind: "fill", value: cred.username },
      { role: "textbox", name: "/email or phone/i" },
      { goal: "type the Google email" },
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^next$/i" },
      { goal: "continue past the email" },
    );
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (/couldn.t find your google account/i.test(text))
    throw new LoginFailed(site, "unknown account");
  // An account with a passkey is asked for it first ("Verifying it's
  // you... Complete sign-in using your passkey", challenge/pk). There is
  // no passkey here; the selection page offers the password (mapped 2026-09-19).
  if (
    cred.passkeys.length &&
    (/using your passkey/i.test(text) || /challenge\/pk/.test(fp.url()))
  ) {
    // Our authenticator holds the passkey: the ceremony completes on its own.
    await fp.waitForUrl((u) => !/challenge\/pk/.test(u), 20_000);
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (/using your passkey/i.test(text) || /challenge\/pk/.test(fp.url())) {
    // "Try another way" on a sign-in, "More ways to verify" on a re-auth.
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/try another way|more ways to verify/i" },
      { goal: "skip the passkey" },
    );
    await fp.waitForUrl(/challenge\/selection/, 10_000);
    await fp.wait(SETTLE_MS);
    // The password when it is offered; otherwise the second steps below (our TOTP).
    const password = choice("Enter your password");
    if (await fp.has(password, 3_000)) {
      await fp.act({ kind: "click" }, password, { goal: "sign in with the password instead" });
      await fp.waitForUrl(/challenge\/pwd/, 10_000);
      await fp.wait(SETTLE_MS);
    }
    text = await fp.text();
  }
  if (await fp.has({ role: "textbox", name: "/password/i" }, RENDER_MS)) {
    await fp.act(
      { kind: "fill", value: cred.password },
      { role: "textbox", name: "/password/i" },
      { goal: "type the Google password" },
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^next$/i" },
      { goal: "submit the password" },
    );
    await fp.waitForUrl((u) => !/challenge\/pwd/.test(u), 10_000);
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (/wrong password/i.test(text) && cred.previousPassword) {
    await fp.act(
      { kind: "fill", value: cred.previousPassword },
      { role: "textbox", name: "/password/i" },
      { goal: "type the previous Google password" },
    );
    await fp.act({ kind: "click" }, { role: "button", name: "/^next$/i" }, { goal: "submit it" });
    await fp.waitForUrl((u) => !/challenge\/pwd/.test(u), 10_000);
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (/wrong password/i.test(text)) throw new LoginFailed(site, "password rejected");
  if (/browser or app may not be secure/i.test(text))
    throw new LoginFailed(site, "Google refused this browser");
  // Only while still on a challenge: the destination itself may talk about codes (the 2SV settings).
  if (
    /accounts\.google\.com/.test(fp.url()) &&
    /2-step verification|authenticator|enter the code|verification code/i.test(text)
  ) {
    await googleSecondStep(ctx);
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (/verify it.s you|confirm your recovery|tap yes on your/i.test(text))
    throw new LoginFailed(site, "Google asked for a second step this tool cannot answer");
}

/** A 6+ digit code goes into the code box and Next. */
async function submitCode(fp: FlowPage, code: string): Promise<void> {
  await fp.act(
    { kind: "fill", value: code },
    { role: "textbox", name: "/code/i" },
    { goal: "type the verification code" },
  );
  await fp.act(
    { kind: "click" },
    { role: "button", name: "/^next$/i" },
    { goal: "submit the code" },
  );
}

/** Google's "Choose how you want to sign in" list, or the step it landed on by itself. */
async function toSelection(fp: FlowPage): Promise<void> {
  if (/challenge\/selection/.test(fp.url())) return;
  if (await fp.has({ text: "/try another way/i" })) {
    await fp.act(
      { kind: "click" },
      { text: "/try another way/i" },
      { goal: "see the other second steps" },
    );
    await fp.waitForUrl(/challenge\/selection/, 10_000);
    await fp.wait(SETTLE_MS);
  }
}

/**
 * The second step, by what this system can answer (mapped 2026-09-19):
 *   1. authenticator code   (our TOTP seed)          "Get a verification code from the Google Authenticator app"
 *   2. SMS code             (paired phone or Twilio)  "Get a verification code at (•••) •••-••18"
 *   3. device prompt        (a person's phone)        "Tap Yes on your phone or tablet", after a note to that phone
 * Google shows the steps as links on challenge/selection; "Try another way" opens it.
 */
/** A step on the selection page: a link on some accounts, a button on others; a greyed one does not count. */
const choice = (text: string): Hints => ({
  css: `:is(a,button,[role=link],[role=button]):not([aria-disabled="true"]):has-text("${text}")`,
});

async function googleSecondStep(ctx: SignInContext): Promise<void> {
  const { fp } = ctx;
  const site = "google";
  const codeBox = { role: "textbox", name: "/code/i" } as const;
  if (ctx.offers("totp")) {
    if (!/challenge\/totp/.test(fp.url())) {
      await toSelection(fp);
      await fp.act({ kind: "click" }, choice("authenticator app"), {
        goal: "choose the authenticator app",
      });
      await fp.wait(SETTLE_MS);
    }
    return submitCode(fp, await ctx.code("totp"));
  }
  await toSelection(fp);
  // Google lists every phone it knows, masked to the last two digits, and
  // greys out one it was given minutes ago ("for your security"). Only a
  // live link to the phone we can read counts.
  const tail = ctx.inbox("sms")?.slice(-2);
  const smsLink: Hints = { css: `${choice("verification code at").css}:has-text("••${tail}")` };
  if (ctx.offers("sms") && tail && (await fp.has(smsLink))) {
    await fp.act({ kind: "click" }, smsLink, { goal: "have Google text the code" });
    await fp.wait(SETTLE_MS);
    if (!(await fp.has(codeBox, RENDER_MS)))
      throw new LoginFailed(site, "no code box after asking for the SMS");
    return submitCode(fp, await ctx.code("sms", "google"));
  }
  if (ctx.notify) {
    const before = fp.url();
    await fp.act({ kind: "click" }, choice("Tap Yes on your phone"), {
      goal: "ask the phone for a Yes",
    });
    // The page says where the prompt went ("Open the YouTube app on Apple iPhone 12"); pass it on.
    await fp.wait(SETTLE_MS);
    const where = (await fp.text()).match(/open the .{1,60}? app on [^\n.]{1,60}/i)?.[0];
    await ctx.notify(
      `Google sign-in for ${ctx.cred.username}: ${where ?? "tap Yes on your phone"} and tap Yes`,
    );
    const moved = await fp.waitForUrl(
      (u) => !/accounts\.google\.com\/v3\/signin\/challenge/.test(u) && u !== before,
      PROMPT_MS,
    );
    if (!moved) throw new LoginFailed(site, "no Yes from the phone within three minutes");
    return;
  }
  throw new LoginFailed(
    site,
    "Google wants a second step and none is set up: enroll TOTP, link a phone, or configure Twilio",
  );
}

export interface OauthLoginSpec {
  start: string;
  /** The "Sign in with Google" button on the site's login page. */
  button: Hints;
  /** Which stored credential the provider takes; `google` by default. */
  provider?: "google";
  /** The site's page after the round trip. */
  success: RegExp;
}

/** Sign in through an identity provider's button: popup or redirect, then back to the site. */
export function oauthLogin(site: string, spec: OauthLoginSpec): SiteLogin["signIn"] {
  const provider = spec.provider ?? "google";
  return async (ctx) => {
    const { fp } = ctx;
    const main = fp.page;
    await fp.open(spec.start, { allowWall: true });
    const popup = fp.nextPage(8_000);
    await fp.act({ kind: "click" }, spec.button, { goal: `sign in with ${provider}` });
    const page = await popup;
    if (page) fp.switchTo(page);
    else if (
      !(await fp.waitForUrl(/accounts\.google\.com/, 15_000)) &&
      !/accounts\.google\.com/.test(fp.url())
    )
      throw new LoginFailed(site, `no ${provider} sign-in page after pressing the button`);
    const cred = await ctx.credFor(provider);
    await signInToGoogle({ ...ctx, cred });
    fp.switchTo(main);
    if (!(await fp.waitForUrl(spec.success, 30_000)) && !spec.success.test(fp.url()))
      throw new LoginFailed(site, `still on ${fp.url()} after the ${provider} round trip`);
  };
}

export interface LoginOptions {
  credentials: CredentialStore;
  codes: CodeSource;
  notify?: (text: string) => Promise<void>;
  now?: () => Date;
}

export type LoginOutcome = "signed-in" | "no-credential" | "unknown-site";

/**
 * The runner's hook: on a login wall for `site`, sign in with what the
 * store has. `LoginFailed` (or a NeedsHuman from inside) propagates.
 */
export function loginProvider(sites: readonly SiteLogin[], opts: LoginOptions) {
  const byName = new Map(sites.map((s) => [s.site, s]));
  const now = opts.now ?? (() => new Date());
  return async (fp: FlowPage, site: string): Promise<LoginOutcome> => {
    const login = byName.get(site);
    if (!login) return "unknown-site";
    const cred = await opts.credentials.get(login.credential ?? site);
    if (!cred) return "no-credential";
    const since = now();
    const ctx: SignInContext = {
      fp,
      cred,
      async code(kind, hint) {
        const req = hint ? { site, kind, since, hint } : { site, kind, since };
        const c = await opts.codes.get(req, ctx.cred);
        if (!c) throw new LoginFailed(site, `no ${kind} code available`);
        return c;
      },
      offers: (kind) => opts.codes.offers(kind, ctx.cred),
      inbox: (kind) => opts.codes.inbox(kind, ctx.cred),
      ...(opts.notify ? { notify: opts.notify } : {}),
      async credFor(other) {
        const c = await opts.credentials.get(other);
        if (!c) throw new LoginFailed(site, `no credential stored for ${other}`);
        return c;
      },
    };
    const here = login.signInHere;
    if (here?.at.test(fp.url())) {
      await here.run(ctx);
      if (!(await fp.waitForUrl((u) => !here.at.test(u), 30_000)))
        throw new LoginFailed(site, `still on ${fp.url()} after signing in`);
      return "signed-in";
    }
    await login.signIn(ctx);
    if (!(await login.loggedIn(fp)))
      throw new LoginFailed(site, "sign-in ran but the page is not signed in");
    return "signed-in";
  };
}

export type LoginProvider = ReturnType<typeof loginProvider>;
