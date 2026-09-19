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
  /** True when the page shows a signed-in state (avatar, dashboard, no sign-in form). */
  loggedIn(fp: FlowPage): Promise<boolean>;
  signIn(ctx: SignInContext): Promise<void>;
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

export function formLogin(site: string, spec: FormLoginSpec): SiteLogin["signIn"] {
  return async ({ fp, cred, code }) => {
    await fp.open(spec.start, { allowWall: true });
    await fp.act({ kind: "fill", value: cred.username }, spec.username, { goal: "type username" });
    if (spec.next) await fp.act({ kind: "click" }, spec.next, { goal: "continue past username" });
    await fp.act({ kind: "fill", value: cred.password }, spec.password, { goal: "type password" });
    await fp.act({ kind: "click" }, spec.submit, { goal: "submit login form" });
    await fp.wait(SETTLE_MS);
    let text = await fp.text();
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
  if (await fp.has({ role: "textbox", name: "/email or phone/i" })) {
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
  if (await fp.has({ role: "textbox", name: "/password/i" })) {
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
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (/wrong password/i.test(text)) throw new LoginFailed(site, "password rejected");
  if (/browser or app may not be secure/i.test(text))
    throw new LoginFailed(site, "Google refused this browser");
  if (/2-step verification|authenticator|enter the code|verification code/i.test(text)) {
    if (
      (await fp.has({ text: "/try another way/i" })) &&
      !(await fp.has({ role: "textbox", name: "/code/i" }))
    ) {
      await fp.act(
        { kind: "click" },
        { text: "/try another way/i" },
        { goal: "choose a different second step" },
      );
      await fp.wait(SETTLE_MS);
      await fp.act(
        { kind: "click" },
        { text: "/authenticator app/i" },
        { goal: "choose the authenticator app" },
      );
      await fp.wait(SETTLE_MS);
    }
    const code = await ctx.code("totp");
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
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (/verify it.s you|confirm your recovery|tap yes on your/i.test(text))
    throw new LoginFailed(
      site,
      "Google asked for a second step this tool cannot answer: enroll TOTP",
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
      async credFor(other) {
        const c = await opts.credentials.get(other);
        if (!c) throw new LoginFailed(site, `no credential stored for ${other}`);
        return c;
      },
    };
    await login.signIn(ctx);
    if (!(await login.loggedIn(fp)))
      throw new LoginFailed(site, "sign-in ran but the page is not signed in");
    return "signed-in";
  };
}

export type LoginProvider = ReturnType<typeof loginProvider>;
