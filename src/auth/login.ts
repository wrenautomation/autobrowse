/**
 * Signing in as code. A `SiteLogin` knows one site's login page: how to
 * tell a signed-in page from a wall, and the gestures from the sign-in
 * button to the dashboard. Passwords come from the credential store,
 * second factors from the code sources; the flow only sees `fp.act`.
 *
 * `formLogin` covers the common shape (username, maybe a Next, password,
 * submit, maybe a code). Sites that differ write `signIn` by hand.
 */

import type { Credential, CredentialStore, SecretAudit } from "credvault";
import type { FlowPage } from "../browser/flow.js";
import type { Hints } from "../browser/locate.js";
import { wallOf } from "../browser/session.js";
import { type CodeKind, type CodeSource, inboxLock } from "./codes.js";
import { guardedPage, hostUnder, registrable } from "./guard.js";
import { type IdentityProvider, type Provider, providerOf, registerProvider } from "./providers.js";

export interface SignInContext {
  fp: FlowPage;
  cred: Credential;
  /**
   * A second-factor code of this kind, or throws when none can be had.
   * `after`: only one that arrived after this (the moment it was asked for),
   * so a text meant for another account on the same phone is never taken.
   */
  code(kind: CodeKind, hint?: string, after?: Date): Promise<string>;
  /**
   * Run `fn` (ask for a code, read it, type it) while no other sign-in on
   * this machine asks the same inbox: codes that look alike stay apart.
   * Absent: `fn` runs at once (`serially`).
   */
  serial?<T>(kind: CodeKind, fn: () => Promise<T>): Promise<T>;
  /** Whether a code of this kind can be had, so the sign-in picks that step on the page. */
  offers(kind: CodeKind): boolean;
  /** Where that code would land, to match against a page that masks numbers ("•••-••82"). */
  inbox(kind: CodeKind): string | null;
  /**
   * A note to the person's phone, for a step only a device can answer
   * ("Tap Yes on your phone"). Absent when no phone is linked.
   */
  notify?: (text: string) => Promise<void>;
  /**
   * Another site's credential (the identity provider behind an OAuth button),
   * or throws. With `account`, the one for that username: the site's own when
   * it matches, else a `<site>@<label>` credential whose username is it.
   */
  credFor(site: string, account?: string): Promise<Credential>;
  /** This context signing in as another credential: its codes come from that one. */
  as(cred: Credential): SignInContext;
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
  via?: readonly Provider[];
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
  /** Where this site shows the account's recovery codes, for `recovery-codes` and after an enrollment. */
  recoveryCodes?: RecoveryCodesSpec;
  /**
   * Registrable domains the credential's password may be typed on, beside
   * `home`'s own (Google signs in on accounts.google.com, Microsoft on
   * live.com and microsoftonline.com). Anywhere else is a leak.
   */
  origins?: readonly string[];
}

/** The passkeys page: the button that starts the ceremony (our authenticator answers it), what the page says after. */
export interface PasskeySetupSpec {
  url: string | ((cred: Credential) => string);
  /** Clicks before `create`, when present (pick the method, "Continue"). */
  before?: Hints[];
  /** The box the site wants the key's name in, before `create`. */
  name?: Hints;
  create: Hints;
  /** Confirmations after `create`, clicked when present ("Continue passkey enrollment"). */
  confirmations?: Hints[];
  done: RegExp;
}

/**
 * The page that lists the account's recovery codes. Each match of `codes`
 * on it is one code, sealed with the credential and never printed.
 */
export interface RecoveryCodesSpec {
  url: string | ((cred: Credential) => string);
  /** The button a page shows when it wants the key again before it shows them. */
  unlock?: Hints;
  codes: RegExp;
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
  /** A saved-account chooser that hides the form: pressed first, only when it shows. */
  reveal?: Hints;
  username: Hints;
  /** Two-page forms: press this after the username. */
  next?: Hints;
  password: Hints;
  submit: Hints;
  /** The second step; a list when the site asks differently by account (an emailed code until 2FA, then the authenticator): the first whose page matches answers. */
  code?: CodeStep | CodeStep[];
  /** A second step our enrolled passkey answers: the page asks, one click starts the ceremony. Tried before `code`. */
  passkey?: { asks: RegExp; start: Hints };
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

/** The credential's password, or a clear failure: a `via` credential has none and belongs on the provider path. */
export function passwordOf(site: string, cred: Credential): string {
  if (!cred.password)
    throw new LoginFailed(
      site,
      `the ${site} credential has no password (it signs in via ${cred.via})`,
    );
  return cred.password;
}

export function formLogin(site: string, spec: FormLoginSpec): SiteLogin["signIn"] {
  return async ({ fp, cred, code }) => {
    const password = passwordOf(site, cred);
    await fp.open(spec.start, { allowWall: true });
    if (spec.reveal && (await fp.has(spec.reveal)))
      await fp.act({ kind: "click" }, spec.reveal, { goal: "past the saved-account chooser" });
    await fp.act({ kind: "fill", value: cred.username }, spec.username, { goal: "type username" });
    if (spec.next) await fp.act({ kind: "click" }, spec.next, { goal: "continue past username" });
    await fp.act({ kind: "fill", value: password }, spec.password, { goal: "type password" });
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
    const byKey = !!(spec.passkey && cred.passkeys.length && spec.passkey.asks.test(text));
    if (spec.passkey && byKey) {
      // Our authenticator holds the key: the ceremony completes on the click.
      await fp.act({ kind: "click" }, spec.passkey.start, { goal: "verify with our passkey" });
      await fp.wait(SETTLE_MS * 2);
      text = await fp.text();
    }
    let step: CodeStep | null = null;
    for (const s of spec.code && !byKey ? [spec.code].flat() : [])
      if (s.asks ? s.asks.test(text) : await fp.has(s.field)) {
        step = s;
        break;
      }
    if (step) {
      const c = await code(step.kind, step.hint);
      await fp.act({ kind: "fill", value: c }, step.field, { goal: "type verification code" });
      await fp.act({ kind: "click" }, step.submit, { goal: "submit verification code" });
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
  // Google One Tap: `gsi/select` is a card, not a sign-in page. It picks an
  // account the profile is already signed in as and asks to confirm it — no
  // password. Its channel to the opener dies if the opener navigates, so
  // nothing here may touch the main page (mapped 2026-09-22 on LinkedIn).
  if (/\/gsi\/select/.test(fp.url())) {
    const confirm = { css: "#confirm_yes" } as const;
    const account = { text: cred.username } as const;
    if (!(await fp.has(confirm, RENDER_MS)) && (await fp.has(account))) {
      await fp.act({ kind: "click" }, account, { goal: "pick the account" });
      await fp.wait(SETTLE_MS);
    }
    if (await fp.has(confirm, RENDER_MS)) {
      await fp.act({ kind: "click" }, confirm, { goal: "confirm the sign-in" });
      return;
    }
    // Neither: the card offers a full sign-in, which the walk below does.
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
      { kind: "fill", value: passwordOf(site, cred) },
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
  // After the password an account with a passkey is asked for it again ("Use your
  // passkey to confirm it's really you", challenge/pk; mapped 2026-09-22 on admin.google.com):
  // "More ways to verify" leads to the same selection page.
  // Google can ask twice: the code, then the passkey again (mapped 2026-09-22 on
  // the Langfuse "Sign in with Google" flow). Each pass goes back to the
  // selection page, so a second one answers with what this system has.
  for (let pass = 0; pass < 2; pass++) {
    const onChallenge =
      /accounts\.google\.com/.test(fp.url()) &&
      (/2-step verification|authenticator|enter the code|verification code/i.test(text) ||
        /use your passkey|using your passkey/i.test(text) ||
        /challenge\/pk/.test(fp.url()));
    if (!onChallenge) break;
    await googleSecondStep(ctx);
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  // A Workspace user's first sign-in: "Welcome to your new account", the
  // terms, and "I understand" (speedbump/gaplustos).
  if (/speedbump\/gaplustos/.test(fp.url()) || /welcome to your new account/i.test(text)) {
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/i understand/i" },
      { goal: "accept the new account's terms" },
    );
    await fp.waitForUrl((u) => !/speedbump/.test(u), 15_000);
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (/verify it.s you|confirm your recovery|tap yes on your/i.test(text))
    throw new LoginFailed(site, "Google asked for a second step this tool cannot answer");
  // The OAuth consent ("Google will allow x.com to access this info about you",
  // "You're signing back in to x"): Continue. A site that asks for more than
  // sign-in (Cal.com: the calendar) shows a second page after it, "already has
  // some access", with its own Continue; it grants nothing new.
  // The page renders late ("Loading"), so the button is awaited, not the text.
  const consent = { role: "button", name: "/^continue$/i" } as const;
  for (let page = 0; page < 3; page++) {
    const at = fp.url();
    if (!/signin\/oauth/.test(at) || !(await fp.has(consent, 8_000))) break;
    await fp.act({ kind: "click" }, consent, { goal: "consent to the sign-in" });
    // A page that did not move will not move on a second press.
    if (!(await fp.waitForUrl((u) => u !== at, 15_000)) || fp.url() === at) break;
  }
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
  const other = { text: "/try another way|more ways to verify/i" } as const;
  if (await fp.has(other)) {
    await fp.act({ kind: "click" }, other, { goal: "see the other second steps" });
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

/** `fn` under the context's inbox lock when it has one. */
export function serially<T>(ctx: SignInContext, kind: CodeKind, fn: () => Promise<T>): Promise<T> {
  return ctx.serial ? ctx.serial(kind, fn) : fn();
}

async function googleSecondStep(ctx: SignInContext): Promise<void> {
  const { fp } = ctx;
  const site = "google";
  const codeBox = { role: "textbox", name: "/code/i" } as const;
  // A passkey we enrolled answers first: for admin.google.com Google offers
  // nothing else on a new browser (mapped 2026-09-22, "Verify it's you →
  // Use your passkey"); our authenticator completes the ceremony on a click.
  let refused: string | null = null;
  if (ctx.cred.passkeys.length) {
    await toSelection(fp);
    const passkey = choice("Use your passkey");
    if (await fp.has(passkey, RENDER_MS)) {
      await fp.act({ kind: "click" }, passkey, { goal: "verify with our passkey" });
      // A "presend" page first ("Your device will ask for your fingerprint… Continue"); then the ceremony.
      const go = { role: "button", name: "/^continue$/i" } as const;
      if (await fp.has(go, RENDER_MS))
        await fp.act({ kind: "click" }, go, { goal: "start the passkey ceremony" });
      const moved = await fp.waitForUrl((u) => !/challenge\/(selection|pk)/.test(u), 20_000);
      if (moved) return;
      // "Something went wrong… Bluetooth" (pk/error): Google does not hold the
      // passkey we hold; the other second steps get their turn, and the
      // error names this when none of them is offered.
      refused = `our passkey was refused (${fp.url().replace(/\?.*/, "")})`;
      await toSelection(fp);
    }
  }
  const only = (what: string) => (refused ? `${what}; ${refused}` : what);
  if (ctx.offers("totp")) {
    if (!/challenge\/totp/.test(fp.url())) {
      await toSelection(fp);
      const totp = choice("authenticator app");
      if (!(await fp.has(totp, RENDER_MS)))
        throw new LoginFailed(site, only("Google does not offer the authenticator app here"));
      await fp.act({ kind: "click" }, totp, { goal: "choose the authenticator app" });
      await fp.wait(SETTLE_MS);
    }
    return submitCode(fp, await ctx.code("totp"));
  }
  // Wrong codes lock the account's texts for hours: say so, never guess on.
  const locked = { text: "/too many failed attempts/i" } as const;
  const lockedOut = () =>
    new LoginFailed(
      site,
      "Google: too many failed attempts on this account; try again in a few hours",
    );
  // "Enter a phone number to get a text message with a verification code": a
  // Workspace user with no phone of its own, asked first (Google stores it). Ours.
  const phoneBox = { role: "textbox", name: "/^phone number$/i" } as const;
  const ours = ctx.inbox("sms");
  const canText = ctx.offers("sms") && Boolean(ours && /^\+?\d[\d\s().-]{6,}$/.test(ours));
  const textOurs = async (): Promise<Date> => {
    if (await fp.has(locked)) throw lockedOut();
    const asked = new Date();
    await fp.act({ kind: "fill", value: ours ?? "" }, phoneBox, { goal: "give Google our phone" });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^next$/i" },
      { goal: "send the text" },
    );
    await fp.wait(SETTLE_MS);
    return asked;
  };
  const answer = async (asked: Date) => {
    if (await fp.has(locked)) throw lockedOut();
    if (!(await fp.has(codeBox, RENDER_MS)))
      throw new LoginFailed(site, "no code box after asking for the SMS");
    // Every sender texts the same phone: only a code that came after this ask is this account's.
    await submitCode(fp, await ctx.code("sms", "google", asked));
    await fp.wait(SETTLE_MS);
    if (await fp.has(locked)) throw lockedOut();
    if (await fp.has({ text: "/wrong code/i" }))
      throw new LoginFailed(site, "Google said the texted code was wrong");
  };
  if (canText && (await fp.has(phoneBox, RENDER_MS)))
    return serially(ctx, "sms", async () => answer(await textOurs()));
  await toSelection(fp);
  // Google lists every phone it knows, masked to the last two digits, and
  // greys out one it was given minutes ago ("for your security"). Only a
  // live link to the phone we can read counts.
  const tail = ours?.slice(-2);
  const smsLink: Hints = { css: `${choice("verification code at").css}:has-text("••${tail}")` };
  // A Workspace user on a new browser gets one choice and no digits: "Get a
  // verification code sent to your phone" (and "Try another way" is a dead end,
  // "Couldn't sign you in"; mapped 2026-09-25). Taken when it is the only phone step.
  const unmasked = choice("verification code sent to your phone");
  const sms =
    ctx.offers("sms") && tail && (await fp.has(smsLink))
      ? smsLink
      : ctx.offers("sms") && (await fp.has(unmasked))
        ? unmasked
        : null;
  if (sms)
    return serially(ctx, "sms", async () => {
      const asked = new Date();
      await fp.act({ kind: "click" }, sms, { goal: "have Google text the code" });
      await fp.wait(SETTLE_MS);
      if (canText && (await fp.has(phoneBox, RENDER_MS))) return answer(await textOurs());
      return answer(asked);
    });
  if (ctx.notify && (await fp.has(choice("Tap Yes on your phone")))) {
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
    only(
      "Google wants a second step and none is set up: enroll TOTP, link a phone, or configure Twilio",
    ),
  );
}

export interface OauthLoginSpec {
  start: string;
  /** The provider's button on the site's login page; the provider's own readings when absent. */
  button?: Hints;
  /** Which identity provider (and stored credential) signs in; `google` by default. */
  provider?: Provider;
  /** The site's page after the round trip: a URL pattern, or a check on the page. */
  success: RegExp | ((fp: FlowPage) => Promise<boolean>);
  /**
   * The site's own second step after the provider (Twilio texts a code even
   * to a Google sign-in): answered with the site's credential and inboxes.
   */
  challenge?: { at: RegExp; run(ctx: SignInContext): Promise<void> };
  /** Which account at the provider, when the site's is not the provider's stored one. */
  account?: string;
}

/** The provider's button as this site shows it: the spec's hint, else the first of the provider's readings on the page. */
async function providerButton(fp: FlowPage, p: IdentityProvider, hint?: Hints): Promise<Hints> {
  if (hint) return hint;
  for (const h of p.buttons) if (await fp.has(h, 1_500)) return h;
  throw new LoginFailed(fp.url(), `no "${p.site}" button on this page`);
}

/** Sign in through an identity provider's button: popup or redirect, then back to the site. */
export function oauthLogin(site: string, spec: OauthLoginSpec): SiteLogin["signIn"] {
  const provider = providerOf(spec.provider ?? "google");
  return async (ctx) => {
    const { fp } = ctx;
    const main = fp.page;
    await fp.open(spec.start, { allowWall: true });
    const opened = () => fp.pages().find((p) => p !== main && provider.host.test(p.url())) ?? null;
    // One Tap opens its own card as the page loads (`auto_select`), before
    // anything is pressed — and the button under that card can then be
    // unclickable. A card that is already there is the sign-in (LinkedIn, 2026-09-22).
    let page = opened();
    if (!page) {
      const button = await providerButton(fp, provider, spec.button);
      const popup = fp.nextPage(8_000);
      const failed = await fp
        .act({ kind: "click" }, button, { goal: `sign in with ${provider.site}` })
        .then(
          () => null,
          (err: unknown) => err,
        );
      page = (await popup) ?? opened();
      if (!page) {
        if (failed) throw failed;
        if (!(await fp.waitForUrl(provider.host, 15_000)) && !provider.host.test(fp.url()))
          throw new LoginFailed(site, `no ${provider.site} sign-in page after pressing the button`);
      }
    }
    if (page) fp.switchTo(page);
    const cred = await ctx.credFor(provider.site, spec.account);
    await provider.signIn(ctx.as(cred));
    fp.switchTo(main);
    await landAfterOauth(site, spec, ctx);
  };
}

/**
 * Any site whose credential says `via`: its login page is where the wall
 * was met (or the credential's `url`), the provider's button is found by
 * its readings, and "signed in" means the page is no longer a wall. This
 * is what makes a provider sign-in work on a site nobody wrote a spec for.
 */
export function viaLogin(site: string, cred: Credential): SiteLogin {
  const provider = providerOf(cred.via as Provider);
  const signedIn = async (fp: FlowPage) =>
    !provider.host.test(fp.url()) && wallOf(fp.url(), (await fp.text()).slice(0, 4000)) === null;
  return {
    site,
    home: cred.url ?? "",
    loggedIn: signedIn,
    signIn: async (ctx) => {
      const start = cred.url ?? ctx.fp.url();
      if (!/^https?:/.test(start))
        throw new LoginFailed(site, "no sign-in page known: store the credential with a url");
      await oauthLogin(site, {
        start,
        provider: provider.site,
        success: signedIn,
        account: cred.username,
      })(ctx);
    },
  };
}

/** Back from the provider: the site's own challenge if it shows one, then its signed-in page. */
export async function landAfterOauth(
  site: string,
  spec: Pick<OauthLoginSpec, "success" | "challenge" | "provider">,
  ctx: SignInContext,
): Promise<void> {
  const { fp } = ctx;
  const provider = spec.provider ?? "google";
  const fail = () => new LoginFailed(site, `still on ${fp.url()} after the ${provider} round trip`);
  const challenge = spec.challenge;
  const success = spec.success;
  if (challenge) {
    const at = (u: string) =>
      (success instanceof RegExp && success.test(u)) || challenge.at.test(u);
    if (!(await fp.waitForUrl(at, 30_000)) && !at(fp.url())) throw fail();
    if (challenge.at.test(fp.url())) await challenge.run(ctx);
  }
  if (success instanceof RegExp) {
    if (!(await fp.waitForUrl(success, 30_000)) && !success.test(fp.url())) throw fail();
    return;
  }
  // A check on the page rather than a URL: give the round trip a moment to land, then ask.
  for (let i = 0; i < 10; i++) {
    if (await success(fp)) return;
    await fp.wait(SETTLE_MS);
  }
  throw fail();
}

const sameUser = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface LoginOptions {
  credentials: CredentialStore;
  codes: CodeSource;
  notify?: (text: string) => Promise<void>;
  /** Where every password use is recorded (allowed or refused). */
  audit?: SecretAudit;
  now?: () => Date;
}

/**
 * The domains a credential's password may be typed on: its site's `home`
 * and `origins`, the credential's own `url`; for a name no spec knows, hosts
 * that carry the name (`instantly` → app.instantly.ai).
 */
export function passwordDomains(
  sites: readonly SiteLogin[],
  name: string,
  cred: Pick<Credential, "url">,
): string[] {
  const base = name.split("@")[0] ?? name;
  const login = sites.find((s) => (s.credential ?? s.site) === base) ?? resolveLogin(sites, base);
  const out = new Set<string>();
  if (login) {
    out.add(registrable(new URL(login.home).host));
    for (const d of login.origins ?? []) out.add(d);
  }
  if (cred.url) out.add(registrable(new URL(cred.url).host));
  return [...out];
}

export type LoginOutcome = "signed-in" | "no-credential" | "unknown-site";

/**
 * A site name may carry an account: `google@ops` is the google login with
 * the credential and browser profile "google@ops". One profile per
 * identity, so two accounts on one site never meet in a chooser. A bare
 * name keeps the spec's own credential (or the site name) and profile.
 */
export function resolveLogin(sites: readonly SiteLogin[], name: string): SiteLogin | null {
  const at = name.indexOf("@");
  const base = sites.find((s) => s.site === (at < 0 ? name : name.slice(0, at)));
  if (!base) return null;
  if (at < 0) return base;
  // `gmail@will` signs in as `google@will`: an app's second account is its provider's.
  return { ...base, site: name, credential: `${base.credential ?? base.site}${name.slice(at)}` };
}

/**
 * May a secret a compiled workflow of `site` fetched be typed on `host`?
 * A known site: its login origins. Any site: a host whose registrable
 * name IS the site's word (`instantly` → app.instantly.ai, never
 * instantly-help.evil.example). Never a host that is neither.
 */
export function siteAllowsHost(sites: readonly SiteLogin[], site: string, host: string): boolean {
  const word = (site.split("@")[0] ?? site).toLowerCase();
  const h = host.toLowerCase();
  if (word && registrable(h).split(".")[0] === word) return true;
  const login = sites.find((s) => (s.credential ?? s.site) === word) ?? resolveLogin(sites, site);
  if (!login) return false;
  const origins = [registrable(new URL(login.home).host), ...(login.origins ?? [])];
  return origins.some((d) => hostUnder(h, d));
}

/** The credential a site name signs in with. */
export function credentialFor(sites: readonly SiteLogin[], name: string): string {
  const login = resolveLogin(sites, name);
  return login?.credential ?? name;
}

export interface SignInParts {
  fp: FlowPage;
  /** The site being signed in to (for messages and code requests). */
  site: string;
  cred: Credential;
  credentials: CredentialStore;
  codes: CodeSource;
  notify?: (text: string) => Promise<void>;
  /** Only codes that arrived after this count; now unless said. */
  since?: Date;
  /** One ask per inbox at a time; `inboxLock` (a lock dir in tmp) unless said. */
  lockInbox?: (inbox: string) => Promise<() => Promise<void>>;
  /** The credential's store name (`google@will`); the site's when absent. */
  credential?: string;
  /** Domains a credential's password may be typed on; the page refuses it elsewhere. Absent: unbound. */
  domainsFor?: (name: string, cred: Credential) => readonly string[];
  audit?: SecretAudit;
}

/**
 * The context a sign-in runs with, over a page the caller drives and the
 * stores it names: what `loginProvider` builds on a wall, on its own for a
 * caller who wants one login (`signInToGoogle(signInContext({...}))`).
 * Codes belong to the credential: an OAuth sign-in continues as the
 * provider's (`ctx.as(cred)`), and its TOTP must answer, not the site's.
 */
export function signInContext(p: SignInParts): SignInContext {
  const { site } = p;
  const since = p.since ?? new Date();
  // Which store name a credential came from, so its page is bound to that name's origins.
  const names = new WeakMap<Credential, string>();
  names.set(p.cred, p.credential ?? site);
  const pageFor = (cred: Credential): FlowPage => {
    const name = names.get(cred) ?? site;
    const domains = p.domainsFor?.(name, cred);
    if (!domains && !p.audit) return p.fp;
    return guardedPage(p.fp, {
      name,
      cred,
      // No domains known: the name itself must be in the host (`instantly` → app.instantly.ai).
      domains: domains?.length ? domains : [],
      site,
      by: "login",
      ...(p.audit ? { audit: p.audit } : {}),
      ...(domains?.length ? {} : { fallback: name.split("@")[0] ?? name }),
    });
  };
  const contextAs = (cred: Credential): SignInContext => ({
    fp: pageFor(cred),
    cred,
    async code(kind, hint, after) {
      const from = after && after > since ? after : since;
      const req = hint ? { site, kind, since: from, hint } : { site, kind, since: from };
      const c = await p.codes.get(req, cred);
      if (!c) throw new LoginFailed(site, `no ${kind} code available`);
      return c;
    },
    offers: (kind) => p.codes.offers(kind, cred),
    inbox: (kind) => p.codes.inbox(kind, cred),
    async serial(kind, fn) {
      const inbox = p.codes.inbox(kind, cred);
      if (!inbox) return fn();
      const release = await (p.lockInbox ?? inboxLock)(inbox);
      try {
        return await fn();
      } finally {
        await release();
      }
    },
    ...(p.notify ? { notify: p.notify } : {}),
    async credFor(other, account) {
      const c = await p.credentials.get(other);
      if (!c) throw new LoginFailed(site, `no credential stored for ${other}`);
      names.set(c, other);
      if (!account || sameUser(c.username, account)) return c;
      // A second account at the provider lives as `<provider>@<label>`.
      for (const name of await p.credentials.list()) {
        if (!name.startsWith(`${other}@`)) continue;
        const alt = await p.credentials.get(name);
        if (alt && sameUser(alt.username, account)) {
          names.set(alt, name);
          return alt;
        }
      }
      throw new LoginFailed(
        site,
        `no ${other} credential for ${account}: autobrowse creds set ${other}@<label> with that username`,
      );
    },
    as: contextAs,
  });
  return contextAs(p.cred);
}

/**
 * The runner's hook: on a login wall for `site`, sign in with what the
 * store has. `LoginFailed` (or a NeedsHuman from inside) propagates.
 */
export function loginProvider(sites: readonly SiteLogin[], opts: LoginOptions) {
  const now = opts.now ?? (() => new Date());
  return async (fp: FlowPage, site: string, account?: string): Promise<LoginOutcome> => {
    let name = site;
    let known = resolveLogin(sites, name);
    let cred = await opts.credentials.get(known?.credential ?? name);
    // The caller knows whose sign-in this is (the account an OAuth consent
    // is for): a second account at the same provider lives as `<site>@<label>`,
    // and that credential — not the site's default one — signs in.
    if (account && !(cred && isUser(cred, account))) {
      const base = known?.credential ?? name;
      for (const other of await opts.credentials.list()) {
        if (!other.startsWith(`${base}@`)) continue;
        const alt = await opts.credentials.get(other);
        if (!alt || !isUser(alt, account)) continue;
        name = other;
        known = resolveLogin(sites, other) ?? known;
        cred = alt;
        break;
      }
    }
    if (!cred) return known ? "no-credential" : "unknown-site";
    const since = now();
    // One account, several ways in: each method in turn until one signs in.
    let first: unknown = null;
    for (const method of methodsOf(cred)) {
      // A method via a provider takes the generic provider path when the
      // site's own spec does not know that provider (or there is no spec at all).
      const login =
        method.via && !known?.via?.includes(method.via as Provider)
          ? viaLogin(name, method)
          : known;
      if (!login) continue;
      const ctx = signInContext({
        fp,
        site: name,
        cred: method,
        since,
        credential: known?.credential ?? name,
        credentials: opts.credentials,
        codes: opts.codes,
        domainsFor: (name, c) => passwordDomains(sites, name, c),
        ...(opts.audit ? { audit: opts.audit } : {}),
        ...(opts.notify ? { notify: opts.notify } : {}),
      });
      try {
        await signInWith(name, login, ctx);
        return "signed-in";
      } catch (err) {
        // Only a refused sign-in moves on; a page that needs a person stops here.
        if (!(err instanceof LoginFailed)) throw err;
        first ??= err;
      }
    }
    if (first) throw first;
    return "unknown-site";
  };
}

async function signInWith(name: string, login: SiteLogin, ctx: SignInContext): Promise<void> {
  const { fp } = ctx;
  const here = login.signInHere;
  if (here?.at.test(fp.url())) {
    await here.run(ctx);
    if (!(await fp.waitForUrl((u) => !here.at.test(u), 30_000)))
      throw new LoginFailed(name, `still on ${fp.url()} after signing in`);
    return;
  }
  await login.signIn(ctx);
  if (!(await login.loggedIn(fp)))
    throw new LoginFailed(name, "sign-in ran but the page is not signed in");
}

/** The account's address: its codes inbox when it signs in with a handle, else the username. */
export const addressOf = (cred: Pick<Credential, "username" | "codesInbox">): string =>
  cred.codesInbox ?? cred.username;

const isUser = (cred: Credential, account: string) =>
  sameUser(cred.username, account) || sameUser(addressOf(cred), account);

/**
 * The ways one account signs in, in the order tried: its own password
 * first, then the provider's button (as the account's address there).
 * A credential with one of them has one method.
 */
export function methodsOf(cred: Credential): Credential[] {
  if (!cred.password || !cred.via) return [cred];
  const { via: _v, ...own } = cred;
  const { password: _p, previousPassword: _pp, ...viaOnly } = cred;
  return [own, { ...viaOnly, username: addressOf(cred) }];
}

export type LoginProvider = ReturnType<typeof loginProvider>;

registerProvider({
  site: "google",
  host: /accounts\.google\.com/,
  buttons: [
    { role: "button", name: "/google/i" },
    { role: "link", name: "/google/i" },
    { text: "/(continue|sign ?in|log ?in|sign ?up) with google/i" },
    // Google Identity Services renders the button itself, cross-origin, so the
    // page's own locators never see it (LinkedIn, mapped 2026-09-22).
    { frame: 'iframe[src*="accounts.google.com/gsi/button"]', css: "div[role=button]" },
  ],
  signIn: signInToGoogle,
});
