/**
 * A sign-in as data (designs/2026-10-04-mods.md): the inputs `formLogin` or
 * `oauthLogin` take, as JSON. The owner's own `logins/<site>.json` and
 * installed mods' load into `SITE_LOGINS` at start, after every built-in,
 * so a built-in login for the same site wins. A data login names no other
 * credential than its site's, and its home and origins carry the site's
 * own name, so a mod can't send a stored password anywhere new.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hostNamed } from "../auth/guard.js";
import {
  type FormLoginSpec,
  formLogin,
  type OauthLoginSpec,
  oauthLogin,
  type SiteLogin,
} from "../auth/login.js";
import { PROVIDERS } from "../auth/providers.js";
import { addSiteLogins, builtInLogin } from "../auth/sites.js";
import { hintsSchema } from "../compiler/outline.js";
import { hostOf, inDomains, installedMods, type Mod } from "./mod.js";

/** `/source/flags`, or a plain source matched without case. */
const pattern = z.string().refine((s) => {
  try {
    regexOf(s);
    return true;
  } catch {
    return false;
  }
}, "not a regular expression");

export function regexOf(s: string): RegExp {
  const m = /^\/(.*)\/([dgimsuy]*)$/s.exec(s);
  return m ? new RegExp(m[1] as string, m[2]) : new RegExp(s, "i");
}

const codeStep = z.object({
  kind: z.enum(["totp", "email", "sms"]),
  field: hintsSchema,
  submit: hintsSchema,
  asks: pattern.optional(),
  hint: z.string().optional(),
});

export const dataLoginSchema = z
  .object({
    site: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    home: z.string().url(),
    ask: z.string().optional(),
    /** Hosts the password may also be typed on, each carrying the site's name. */
    origins: z.array(z.string()).optional(),
    /** Signed in: the URL matches, and the element (when named) is on the page. */
    signedIn: z.object({ url: pattern.optional(), has: hintsSchema.optional() }),
    form: z
      .object({
        start: z.string().url(),
        reveal: hintsSchema.optional(),
        username: hintsSchema,
        next: hintsSchema.optional(),
        password: hintsSchema,
        submit: hintsSchema,
        code: z.array(codeStep).optional(),
        success: pattern.optional(),
        rejected: pattern.optional(),
        captcha: hintsSchema.optional(),
      })
      .optional(),
    oauth: z
      .object({
        start: z.string().url(),
        before: z.array(hintsSchema).optional(),
        button: hintsSchema.optional(),
        provider: z.enum(PROVIDERS).optional(),
        success: pattern,
      })
      .optional(),
  })
  .refine((l) => !!l.form !== !!l.oauth, "a login is a form or an oauth, one of them")
  .refine((l) => l.signedIn.url || l.signedIn.has, "signedIn needs a url or a has");
export type DataLogin = z.infer<typeof dataLoginSchema>;

/** The `SiteLogin` a data login means; built from the same `formLogin`/`oauthLogin` the built-ins use. */
export function loginOf(l: DataLogin): SiteLogin {
  const url = l.signedIn.url ? regexOf(l.signedIn.url) : null;
  const { has } = l.signedIn;
  const re = (src?: string) => (src ? regexOf(src) : undefined);
  const signIn = l.form
    ? formLogin(l.site, {
        ...l.form,
        code: l.form.code?.map((c) => ({ ...c, asks: re(c.asks) })),
        success: re(l.form.success),
        rejected: re(l.form.rejected),
      } as FormLoginSpec)
    : oauthLogin(l.site, {
        ...l.oauth,
        success: re(l.oauth?.success),
      } as OauthLoginSpec);
  return {
    site: l.site,
    home: l.home,
    ...(l.ask ? { ask: l.ask } : {}),
    ...(l.origins ? { origins: l.origins } : {}),
    ...(l.oauth ? { via: [l.oauth.provider ?? "google"] } : {}),
    loggedIn: async (fp) => (!url || url.test(fp.url())) && (!has || (await fp.has(has, 1_500))),
    signIn,
  };
}

/** Why a mod's login can't be added; empty when it can. */
export function loginProblems(l: DataLogin, mod: Pick<Mod, "sites" | "domains">): string[] {
  const bad: string[] = [];
  if (!mod.sites.includes(l.site)) bad.push(`site ${l.site} not in sites`);
  if (builtInLogin(l.site)) bad.push(`${l.site} has a built-in login; a mod can't replace it`);
  const word = l.site.split(".")[0] as string;
  const own = (host: string) => hostNamed(host.replace(/:\d+$/, ""), word);
  const start = l.form?.start ?? l.oauth?.start ?? l.home;
  for (const [what, host] of [
    ["home", hostOf(l.home)],
    ["start", hostOf(start)],
    ...(l.origins ?? []).map((o) => ["origin", o]),
  ] as [string, string][]) {
    if (!inDomains(host, mod.domains)) bad.push(`${what} ${host} is outside domains`);
    // Where the site's password goes: only hosts that carry its name.
    if (what !== "start" && !own(host)) bad.push(`${what} ${host} does not carry the name ${word}`);
  }
  return bad;
}

/** Data logins this owner has: its own `logins/*.json`, then installed mods'. A file that does not parse is skipped. */
export function dataLogins(loginsDir: string, modsDir: string): DataLogin[] {
  const read = (file: string): DataLogin[] => {
    try {
      return [dataLoginSchema.parse(JSON.parse(readFileSync(file, "utf8")))];
    } catch {
      return [];
    }
  };
  const own = existsSync(loginsDir)
    ? readdirSync(loginsDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .flatMap((f) => read(join(loginsDir, f)))
    : [];
  const mods = installedMods(modsDir).flatMap((m) =>
    m.mod.files
      .filter((f) => f.kind === "login")
      .flatMap((f) => read(join(m.dir, f.path)))
      .filter((l) => loginProblems(l, m.mod).length === 0),
  );
  return [...own, ...mods];
}

/** Put this owner's data logins in `SITE_LOGINS`: every entry point, right after `boot()`. */
export function registerDataLogins(loginsDir: string, modsDir: string): void {
  addSiteLogins(dataLogins(loginsDir, modsDir).map(loginOf));
}
