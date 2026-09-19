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
}

export interface SiteLogin {
  site: string;
  home: string;
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
    const cred = await opts.credentials.get(site);
    if (!cred) return "no-credential";
    const since = now();
    await login.signIn({
      fp,
      cred,
      async code(kind, hint) {
        const req = hint ? { site, kind, since, hint } : { site, kind, since };
        const c = await opts.codes.get(req, cred);
        if (!c) throw new LoginFailed(site, `no ${kind} code available`);
        return c;
      },
    });
    if (!(await login.loggedIn(fp)))
      throw new LoginFailed(site, "sign-in ran but the page is not signed in");
    return "signed-in";
  };
}

export type LoginProvider = ReturnType<typeof loginProvider>;
