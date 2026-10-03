/**
 * Signing in as code. A `SiteLogin` knows one site's login page: how to
 * tell a signed-in page from a wall, and the gestures from the sign-in
 * button to the dashboard. Passwords come from the credential store,
 * second factors from the code sources; the flow only sees `fp.act`.
 *
 * `formLogin` covers the common shape (username, maybe a Next, password,
 * submit, maybe a code). Sites that differ write `signIn` by hand; a
 * branching one is a walk of screens (`google.ts`).
 */

import type { Credential, CredentialStore, SecretAudit } from "credvault";
import type { FlowPage } from "../browser/flow.js";
import type { Hints } from "../browser/locate.js";
import { pageState, untilLoaded } from "../browser/page-state.js";
import { wallOf } from "../browser/session.js";
import { safeUrls } from "../clients/http.js";
import { type CodeKind, type CodeSource, inboxLock } from "./codes.js";
import { guardedPage, hostUnder, registrable } from "./guard.js";
import { type IdentityProvider, type Provider, providerOf } from "./providers.js";

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
   * it matches, else a `<site>@<label>` (or `<site>-<label>`) credential whose username is it.
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
  /**
   * The password asked again in place, signed in (Discord's box before a
   * bot token reset): filled where it shows, no navigation, so the dialog
   * and what waits behind it survive.
   */
  reauth?: { field: Hints; submit: Hints };
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
  /** A captcha the site may show after submit (Discord's hCaptcha): solved by the runner, else a person's. */
  captcha?: Hints;
}

export class LoginFailed extends Error {
  constructor(site: string, reason: string) {
    super(safeUrls(`${site}: ${reason}`));
    this.name = "LoginFailed";
  }
}

const SETTLE_MS = 1_500;

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
    if (spec.captcha && (await fp.has(spec.captcha))) {
      const got = await fp.captcha();
      if (!got.solved) fp.human(`${site}: the sign-in captcha is a person's (${got.reason})`);
      await fp.wait(SETTLE_MS);
    }
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
    if (!ok)
      throw new LoginFailed(site, `not signed in after the password: ${await pageState(fp)}`);
  };
}

/** `fn` under the context's inbox lock when it has one. */
export function serially<T>(ctx: SignInContext, kind: CodeKind, fn: () => Promise<T>): Promise<T> {
  return ctx.serial ? ctx.serial(kind, fn) : fn();
}

export interface OauthLoginSpec {
  start: string;
  /** Clicks on `start` that bring the provider's button up (a "Sign In" that opens a modal). */
  before?: Hints[];
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
  // An app shell paints its buttons late (Notion's "Loading...", 2026-10-02).
  await untilLoaded(fp, LOADING_MS);
  for (const h of p.buttons) if (await fp.has(h, 1_500)) return h;
  throw new LoginFailed(fp.url(), `no "${p.site}" button: ${await pageState(fp)}`);
}

/** How long a site's own spinner may stand between a press and the next page. */
const LOADING_MS = 30_000;

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
      for (const h of spec.before ?? [])
        await fp.act({ kind: "click" }, h, { goal: `open ${site}'s sign-in` });
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
        // The site's own hop (Todoist's /oauth-start spinner) can take its time.
        const reached = async (ms: number) =>
          (await fp.waitForUrl(provider.host, ms)) || provider.host.test(fp.url());
        const spinning = async () => !(await untilLoaded(fp, 0));
        if (!(await reached(15_000)) && !((await spinning()) && (await reached(LOADING_MS))))
          throw new LoginFailed(
            site,
            `pressed the ${provider.site} button but never reached ${provider.site}: ${await pageState(fp)}`,
          );
      }
    }
    if (page) fp.switchTo(page);
    // A site made through the provider's button signs in as its own username
    // there, never as the provider's stored default: that was a person's own
    // account once, its password typed for a Wren site (2026-09-29).
    const account = spec.account ?? (ctx.cred.via ? ctx.cred.username : undefined);
    const cred = await ctx.credFor(provider.site, account);
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
  // A page that still holds a password field is a sign-in form under some other URL (Telnyx, 2026-09-29).
  // A spinner is neither signed in nor out: wait it out before judging.
  const signedIn = async (fp: FlowPage) =>
    (await untilLoaded(fp, LOADING_MS)) &&
    !provider.host.test(fp.url()) &&
    wallOf(fp.url(), (await fp.text()).slice(0, 4000)) === null &&
    !(await fp.has({ css: "input[type=password]" }, 500));
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
  const fail = async () =>
    new LoginFailed(site, `not signed in after the ${provider} round trip: ${await pageState(fp)}`);
  const challenge = spec.challenge;
  const success = spec.success;
  if (challenge) {
    const at = (u: string) =>
      (success instanceof RegExp && success.test(u)) || challenge.at.test(u);
    if (!(await fp.waitForUrl(at, 30_000)) && !at(fp.url())) throw await fail();
    if (challenge.at.test(fp.url())) await challenge.run(ctx);
  }
  if (success instanceof RegExp) {
    if (!(await fp.waitForUrl(success, 30_000)) && !success.test(fp.url())) throw await fail();
    return;
  }
  // A check on the page rather than a URL: let the app shell load, then ask a few times.
  await untilLoaded(fp, LOADING_MS);
  for (let i = 0; i < 10; i++) {
    if (await success(fp)) return;
    await fp.wait(SETTLE_MS);
  }
  throw await fail();
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
      // A second account at the provider lives as `<provider>@<label>` (or `<provider>-<label>`: google-admin).
      for (const name of await p.credentials.list()) {
        if (!name.startsWith(`${other}@`) && !name.startsWith(`${other}-`)) continue;
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
  if (login.reauth && (await fp.has(login.reauth.field))) {
    await fp.act({ kind: "fill", value: passwordOf(name, ctx.cred) }, login.reauth.field, {
      goal: "type the password again",
    });
    await fp.act({ kind: "click" }, login.reauth.submit, { goal: "confirm with the password" });
    for (let i = 0; i < 15; i++) {
      await fp.wait(1_000);
      if (!(await fp.has(login.reauth.field))) return;
    }
    throw new LoginFailed(name, "the password box stayed up");
  }
  const here = login.signInHere;
  if (here?.at.test(fp.url())) {
    await here.run(ctx);
    if (!(await fp.waitForUrl((u) => !here.at.test(u), 30_000)))
      throw new LoginFailed(name, `not signed in 30s after the form: ${await pageState(fp)}`);
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
