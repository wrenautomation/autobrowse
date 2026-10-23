/**
 * A sign-in walk as a site's `SiteLogin` (designs/2026-10-23-cut-runs.md).
 * `walks cut` builds the walk `login` from the sign-in acts of a run; this
 * runs it with the site's credential and second factors, so a sign-in a run
 * did once needs no hand-written `signIn`.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CodeKind } from "../auth/codes.js";
import type { SiteLogin } from "../auth/login.js";
import { lookAt } from "../browser/screens.js";
import { shows } from "./build.js";
import { walkFlow } from "./flow.js";
import { loadWalk, type WalkSpec } from "./spec.js";

/** Second factors in the order a sign-in tries them, when the site does not say. */
const CODES: readonly CodeKind[] = ["totp", "sms", "email"];

export function walkLogin(
  spec: WalkSpec,
  o: {
    /** The site it signs in to; default: the walk's. */
    site?: string;
    /** The stored credential; default: the site. */
    credential?: string;
    /** The code the page sends (a text for a Duo passcode); default: the first one the credential can get. */
    code?: CodeKind;
    /** Domains the password may be typed on beside home's (an SSO host). */
    origins?: readonly string[];
  } = {},
): SiteLogin {
  if (!spec.start)
    throw new Error(
      `${spec.site}/walk-${spec.name}: a sign-in walk needs a start (the page it lands on)`,
    );
  const goal = spec.screens.find((s) => s.goal);
  // The credential its secrets name (`outlook@uw.password`), when not given.
  const named = spec.secrets.map((x) => x.key).find((k) => /\.(username|password)$/.test(k));
  const credential = o.credential ?? named?.slice(0, named.lastIndexOf("."));
  return {
    site: o.site ?? spec.site,
    home: spec.start,
    ...(credential ? { credential } : {}),
    ...(o.origins ? { origins: o.origins } : {}),
    // Signed in: the page the sign-in landed on, by its look.
    async loggedIn(fp) {
      if (!goal || (goal.url === null && !goal.landmarks.length)) return false;
      return shows(goal.url, goal.landmarks, await lookAt(fp.page));
    },
    async signIn(ctx) {
      const asked = new Date();
      const kind = o.code ?? CODES.find((k) => ctx.offers(k));
      // `<cred>.username` and `.password` from the credential; any other secret is the code the page sent.
      const run = () =>
        walkFlow(spec, {
          secrets: async (key) => {
            const field = key.slice(key.lastIndexOf(".") + 1);
            if (field === "username") return ctx.cred.username;
            if (field === "password") return ctx.cred.password ?? null;
            return kind ? ctx.code(kind, undefined, asked) : null;
          },
        }).run(ctx.fp, {});
      // One sign-in at a time asks this inbox, so a code meant for another stays its own.
      await (kind && ctx.serial ? ctx.serial(kind, run) : run());
    },
  };
}

/**
 * Every site's `login` walk in the owner's walks, as its `SiteLogin`. Added
 * after the built-in and data logins, so a hand login wins: a walk replaces
 * one only after it passes the same screens (a push, a wrong code).
 */
export function walkLogins(walksDir: string): SiteLogin[] {
  if (!existsSync(walksDir)) return [];
  return readdirSync(walksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(walksDir, d.name, "login.json")))
    .flatMap((d) => {
      try {
        return walkLoginAt(walksDir, d.name) ?? [];
      } catch {
        // A walk file the schema refuses: no login, as with no file.
        return [];
      }
    });
}

/** The site's `login` walk as its `SiteLogin`, when `walks cut` built one; else null. */
export function walkLoginAt(
  walksDir: string,
  site: string,
  o: Parameters<typeof walkLogin>[1] = {},
): SiteLogin | null {
  const spec = loadWalk(walksDir, site, "login");
  return spec?.start ? walkLogin(spec, o) : null;
}
