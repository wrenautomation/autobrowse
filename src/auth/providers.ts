/**
 * Identity providers behind "Continue with …" buttons. One entry per
 * provider: how its button reads on any site, where its own pages live,
 * and how to sign in there with the stored credential of that name. A
 * site signs in through a provider when its credential says `via`; no
 * per-site code is needed for that, only the provider entry here.
 */
import type { Hints } from "../browser/locate.js";
import type { SignInContext } from "./login.js";

export const PROVIDERS = ["google", "github", "microsoft"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface IdentityProvider {
  site: Provider;
  /** The provider's own sign-in and consent pages. */
  host: RegExp;
  /** How its button reads on a site's login page, most specific first. */
  buttons: readonly Hints[];
  /** Sign in on the provider's page (popup or redirect); consent pages included. */
  signIn(ctx: SignInContext): Promise<void>;
}

/** The registry is filled by login.ts (its sign-ins live there); importing both never cycles at load. */
const registry = new Map<Provider, IdentityProvider>();

export function registerProvider(p: IdentityProvider): void {
  registry.set(p.site, p);
}

export function providerOf(name: Provider): IdentityProvider {
  const p = registry.get(name);
  if (!p) throw new Error(`no identity provider named ${name}`);
  return p;
}

export function isProvider(name: string): name is Provider {
  return (PROVIDERS as readonly string[]).includes(name);
}
