/**
 * `autobrowse creds …`, `autobrowse login <site>`, `autobrowse enroll-totp
 * <site>`: the credential ladder from the terminal. Values arrive on
 * stdin, never as arguments (argv is visible to every process).
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { credentialSchema } from "credvault";
import { accountsOn, formatAccounts, pickAccount, platformOf } from "../auth/accounts.js";
import { accountSite } from "../auth/identities.js";
import {
  enrollPasskeyFlow,
  enrollTotpFlow,
  ingest,
  isProvider,
  PROVIDERS,
  parseCredentialLines,
  pasteCredential,
  resolveLogin,
  rotatePasswordFlow,
  SITE_LOGINS,
  sealRecoveryCodesFlow,
  takeFile,
  viaLogin,
} from "../auth/index.js";
import { CRED_ENV } from "../auth/keep.js";
import { dropRole, giveRole } from "../auth/roles.js";
import { defineFlow, type FlowPage, flowRunner } from "../browser/flow.js";
import { fileScreens } from "../browser/screens.js";
import { expandHome } from "../google-auth.js";

/** A copied secret lives on the clipboard for a minute, then is emptied if untouched. */
const CLIPBOARD_MS = 60_000;

import { macClipboard } from "./cli-env.js";
import type { Settings } from "./config.js";
import { askSecretTwice } from "./prompt.js";
import { headed } from "./screen.js";
import {
  browserFor,
  browserOptions,
  captchaFor,
  credentialsFor,
  devicesFor,
  gmailFor,
  loginFor,
} from "./services.js";

/** `william@wrenautomation.com` → `w***@wrenautomation.com`: whose, without the address in a log. */
const maskAddress = (u: string) => u.replace(/^(.)[^@]*@/, "$1***@");
const SITES = SITE_LOGINS.map((s) => s.site);
const KNOWN = `one of ${SITES.join(", ")}, <site>@<label> for a second account, or an address (will@a.com) for its own Google account`;

/** A site name (or `site@account`) as a login, or a clear error. */
function loginNamed(site: string) {
  const login = resolveLogin(SITE_LOGINS, site);
  if (!login) throw new Error(`unknown site ${site}; ${KNOWN}`);
  return login;
}

/** A known site's login, or the provider path for any site whose stored credential says `via`. */
async function loginOrVia(settings: Settings, site: string) {
  const known = resolveLogin(SITE_LOGINS, site);
  if (known) return known;
  const cred = await credentialsFor(settings).get(site);
  if (cred?.via) return viaLogin(site, cred);
  throw new Error(
    `unknown site ${site}; ${KNOWN}, or store a provider sign-in first: \`autobrowse creds via ${site} google --url <its login page>\``,
  );
}

export function registerAuthCommands(program: Command, settings: Settings): void {
  program
    .command("setup")
    .description(
      "Ask once for what is missing (root credentials), store it sealed; the rest is automated",
    )
    .action(async () => {
      const { createInterface } = await import("node:readline/promises");
      const { runSetup, terminalPrompter } = await import("./setup.js");
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      try {
        await runSetup(
          terminalPrompter(rl, process.stdout),
          credentialsFor(settings),
          SITE_LOGINS,
          {
            devices: devicesFor(settings),
          },
        );
      } finally {
        rl.close();
      }
    });

  const creds = program.command("creds").description("Site credentials for automated sign-in");
  /** The browser profile carries the sign-in: it moves with the key, unless a browser has it open. */
  const moveProfile = (from: string, to: string): string => {
    const dir = expandHome(settings.profilesDir);
    const [oldDir, newDir] = [join(dir, from), join(dir, to)];
    if (!existsSync(oldDir)) return "";
    if (existsSync(newDir)) return `; its profile stays (${to} has one)`;
    if (existsSync(join(oldDir, "SingletonLock")))
      return `; its profile stays (a browser has it open: autobrowse creds rename ${from} ${to} after)`;
    renameSync(oldDir, newDir);
    return ", profile too";
  };
  creds
    .command("set <site>")
    .description(
      'Store a credential from stdin JSON: {"username","password","totpSecret"?,"codesInbox"?}',
    )
    .action(async (siteArg: string) => {
      const site = accountSite(siteArg);
      const raw = JSON.parse(readFileSync(0, "utf8"));
      const parsed = credentialSchema.safeParse(raw);
      if (!parsed.success) {
        for (const i of parsed.error.issues) console.error(`${i.path.join(".")}: ${i.message}`);
        process.exitCode = 1;
        return;
      }
      const store = credentialsFor(settings);
      const had = await store.get(site);
      // A password joins the account's other ways in (its provider, passkeys); it does not replace them.
      await store.put(site, {
        ...parsed.data,
        ...(had?.via && !raw.via
          ? { via: had.via, codesInbox: parsed.data.codesInbox ?? had.codesInbox ?? had.username }
          : {}),
        ...(had?.passkeys.length && !raw.passkeys ? { passkeys: had.passkeys } : {}),
      });
      console.log(
        `stored credential for ${site}${had?.via && !raw.via ? ` (still signs in via ${had.via} too; the password goes first)` : ""}`,
      );
    });
  creds
    .command("via <site> <provider>")
    .description(
      `The site signs in through a provider's button ("Continue with Google"): no password of its own; the provider's stored credential does the work. Providers: ${PROVIDERS.join(", ")}`,
    )
    .option("--url <url>", "the site's login page (needed for a site autobrowse has no spec for)")
    .option(
      "--account <email>",
      "which account at the provider (default: your account for --for, else the stored one)",
    )
    .option(
      "--for <purpose>",
      "pick the account by purpose (autobrowse accounts): pays, default, …",
    )
    .action(
      async (
        site: string,
        provider: string,
        o: { url?: string; account?: string; for?: string },
      ) => {
        if (!isProvider(provider))
          throw new Error(`unknown provider ${provider}; ${PROVIDERS.join(", ")}`);
        const store = credentialsFor(settings);
        const providerCred = await store.get(provider);
        if (!providerCred)
          throw new Error(
            `store the ${provider} credential first: autobrowse creds set ${provider}`,
          );
        let account = o.account;
        if (!account && (provider === "google" || provider === "microsoft")) {
          const { identityAt } = await import("../auth/identities.js");
          const { identitiesFor } = await import("./services.js");
          const all = await identitiesFor(settings).list();
          // Only a policy pick when one names the purpose; without --for the stored credential stands.
          account = o.for ? identityAt(all, provider, o.for)?.address : undefined;
          if (o.for && !account)
            throw new Error(`no ${provider} account for ${o.for}: autobrowse accounts`);
        }
        const address = account ?? providerCred.username;
        const had = await store.get(site);
        // A stored password stays: the provider becomes the account's second way in.
        await store.put(
          site,
          had?.password
            ? { ...had, via: provider, codesInbox: address, ...(o.url ? { url: o.url } : {}) }
            : { username: address, via: provider, ...(o.url ? { url: o.url } : {}) },
        );
        console.log(
          `${site} signs in via ${provider}${o.url ? ` at ${o.url}` : ""}${had?.password ? " (its password goes first)" : ""}`,
        );
      },
    );
  creds
    .command("rename <from> <to>")
    .description(
      "Move an account to a clearer name (google@google@wj.dev → google@wj.dev): its credential and its signed-in browser profile; the old name is kept in history",
    )
    .action(async (fromArg: string, toArg: string) => {
      const [from, to] = [accountSite(fromArg), accountSite(toArg)];
      const store = credentialsFor(settings);
      const cred = await store.get(from);
      if (!cred) throw new Error(`no credential stored for ${from}`);
      if (await store.get(to))
        throw new Error(`${to} is taken: \`creds same ${to} ${from}\` merges them`);
      if (!store.remove) throw new Error("this store cannot remove; nothing moved");
      await store.put(to, cred);
      if (!(await store.get(to))) throw new Error(`${to} did not store; ${from} left as is`);
      await store.remove(from);
      console.log(
        `${from} is now ${to}${moveProfile(from, to)}; creds history ${from} keeps the old one`,
      );
    });
  creds
    .command("same <site> <other>")
    .description(
      "Two stored entries are one account (github and github@jinwi): other's ways in (password, authenticator, passkeys) join site's, and other is removed (kept in history). The password goes first, the provider second",
    )
    .action(async (siteArg: string, otherArg: string) => {
      const site = accountSite(siteArg);
      const other = accountSite(otherArg);
      const store = credentialsFor(settings);
      const [a, b] = [await store.get(site), await store.get(other)];
      if (!a || !b) throw new Error(`both need a stored credential: ${!a ? site : other}`);
      const own = a.password ? a : b.password ? b : a;
      const via = a.via ?? b.via;
      const address = [a, b].find((c) => c.via)?.username;
      await store.put(site, {
        ...own,
        username: own.password ? own.username : a.username,
        ...(via ? { via } : {}),
        ...(address && own.password ? { codesInbox: own.codesInbox ?? address } : {}),
        totpSecret: a.totpSecret ?? b.totpSecret,
        recoveryCodes: a.recoveryCodes.length ? a.recoveryCodes : b.recoveryCodes,
        passkeys: [...a.passkeys, ...b.passkeys],
      });
      if (!store.remove)
        throw new Error("this store cannot remove; the merge is stored, remove the other by hand");
      await store.remove(other);
      const ways = [
        own.password && "password",
        via && `via ${via}`,
        (a.passkeys.length || b.passkeys.length) && "passkey",
      ].filter(Boolean);
      console.log(
        `${site}: one account, signs in by ${ways.join(", then ")}; ${other} removed (creds history ${other} keeps it)`,
      );
    });
  creds
    .command("made <site>")
    .description(
      "The account behind a minted signup credential exists now (you finished the signup by hand): `needs` stops asking for it",
    )
    .action(async (siteArg: string) => {
      const site = accountSite(siteArg);
      const store = credentialsFor(settings);
      const cred = await store.get(site);
      if (!cred)
        throw new Error(`no credential stored for ${site}: autobrowse signup ${site} first`);
      await store.put(site, { ...cred, madeAt: new Date().toISOString() });
      console.log(`${site}: marked made; copied to the store`);
    });
  creds
    .command("username <site> <name>")
    .description(
      "The site signs in with a handle, not the address (npm): the stored username becomes it, and codes are still read from the address's inbox",
    )
    .action(async (siteArg: string, name: string) => {
      const site = accountSite(siteArg);
      const store = credentialsFor(settings);
      const cred = await store.get(site);
      if (!cred) throw new Error(`no credential stored for ${site}`);
      await store.put(site, {
        ...cred,
        username: name,
        codesInbox: cred.codesInbox ?? cred.username,
      });
      console.log(`${site}: signs in as ${name}; codes still from its inbox; copied to the store`);
    });
  creds
    .command("address <site> <address>")
    .description(
      "The account's sign-in address changed on the site: the stored username follows it, and its codes are read from that inbox",
    )
    .action(async (siteArg: string, address: string) => {
      const site = accountSite(siteArg);
      const store = credentialsFor(settings);
      const cred = await store.get(site);
      if (!cred) throw new Error(`no credential stored for ${site}`);
      await store.put(site, { ...cred, username: address, codesInbox: address });
      console.log(`${site}: username and codes inbox set; copied to the store`);
    });
  creds
    .command("rotate <site>")
    .description(
      "Change the site's password on the site itself: a new random one, or --ask to type it here; stored sealed, nothing printed",
    )
    .option("--headed", "show the browser")
    .option(
      "--ask",
      "type the new password on this terminal (twice, never echoed) instead of drawing one",
    )
    .action(async (siteArg: string, o: { headed?: boolean; ask?: boolean }) => {
      const site = accountSite(siteArg);
      const login = loginNamed(site);
      // Asked for before the browser opens, so a typo costs nothing.
      const chosen = o.ask ? await askSecretTwice(`new password for ${site}`) : null;
      const runner = flowRunner(browserOptions(settings, o.headed ? headed : undefined), {
        login: loginFor(settings, gmailFor(settings)),
        captcha: captchaFor(settings),
      });
      const flow = chosen
        ? rotatePasswordFlow(login, credentialsFor(settings), () => chosen)
        : rotatePasswordFlow(login, credentialsFor(settings));
      console.log(await runner.run(flow, undefined));
    });
  creds
    .command("password <site> [account]")
    .description(
      "The password changed on the site (you changed it by hand): type it here, twice, never echoed; only the store is touched, no browser. Several accounts on the site: name one (label or username)",
    )
    .action(async (given: string, account?: string) => {
      const store = credentialsFor(settings);
      const site = await pickAccount(credentialsFor(settings, { armed: false }), given, account);
      const cred = await store.get(site);
      if (!cred) throw new Error(`no credential stored for ${site}`);
      const next = await askSecretTwice(`password for ${site}`);
      await store.put(site, {
        ...cred,
        password: next,
        ...(cred.password ? { previousPassword: cred.password } : {}),
      });
      console.log(`${site}: stored; copied to the store`);
    });
  creds
    .command("copy <site> [account]")
    .description(
      "One field of a stored credential onto the clipboard (emptied after a minute); nothing is ever printed. Several accounts on the site: name one (label, username, or part of it); `creds list <site>` shows them",
    )
    .option("--field <what>", "password | username | totp | recovery | previous", "password")
    .action(async (given: string, account: string | undefined, o: { field: string }) => {
      const site = await pickAccount(credentialsFor(settings, { armed: false }), given, account);
      const cred = await credentialsFor(settings).get(site);
      if (!cred) throw new Error(`no credential stored for ${site}`);
      const fields: Record<string, string | undefined> = {
        password: cred.password,
        username: cred.username,
        totp: cred.totpSecret,
        recovery: cred.recoveryCodes.join("\n") || undefined,
        previous: cred.previousPassword,
      };
      if (!(o.field in fields))
        throw new Error(`no field ${o.field}: ${Object.keys(fields).join(" | ")}`);
      const value = fields[o.field];
      if (!value) throw new Error(`${site} has no ${o.field} stored`);
      await macClipboard(value, CLIPBOARD_MS);
      console.log(
        `${site} (${cred.username}) ${o.field} is on the clipboard for ${CLIPBOARD_MS / 1000}s`,
      );
    });
  creds
    .command("paste <site>")
    .description(
      "Store what is on the clipboard: `email password [authenticator key]`; the clipboard is emptied after",
    )
    .action(async (siteArg: string) => {
      const site = accountSite(siteArg);
      await pasteCredential(credentialsFor(settings), site);
      console.log(`stored: ${site} (clipboard emptied)`);
    });
  creds
    .command("import <file>")
    .description(
      "Store every line of a scratch file (`site email password [authenticator key]`), then shred the file",
    )
    .action(async (file: string) => {
      const lines = parseCredentialLines(takeFile(file));
      console.log(`stored: ${(await ingest(credentialsFor(settings), lines)).join(", ")}`);
    });
  creds
    .command("push [sites...]")
    .description(
      "This machine's stored credentials into the env store (SSM) as AUTOBROWSE_CRED_<SITE>_*, every field; writes already land there, so this repairs a missed one; --all for every site; nothing printed",
    )
    .option("--all", "every stored site (canaries never travel)")
    .action(async (siteArgs: string[], o: { all?: boolean }) => {
      const sites = siteArgs.map((a) => accountSite(a));
      if (sites.length === 0 && !o.all) throw new Error("name sites, or --all");
      const { pushCredentials } = await import("credvault");
      const { credentialHistoryFor, envStoreFor } = await import("./services.js");
      // Unarmed: the push reads every site to skip the canaries; an armed read of one would trip it.
      const pushed = await pushCredentials(
        credentialsFor(settings, { armed: false, shared: false }),
        envStoreFor(settings),
        sites,
        { ...CRED_ENV, history: credentialHistoryFor(settings) },
      );
      for (const p of pushed) console.log(`pushed ${p.site}: ${p.names.join(", ")}`);
      console.log("the box reads the store on its next deploy (push to main)");
    });
  creds
    .command("pull [sites...]")
    .description(
      "Credentials from the env store into this machine's sealed file (reads fill it on their own; this fills it all at once, e.g. before going offline); a site already here is kept unless --overwrite; passkeys here are never dropped",
    )
    .option("--overwrite", "replace what is here with the store's copy")
    .action(async (siteArgs: string[], o: { overwrite?: boolean }) => {
      const sites = siteArgs.map((a) => accountSite(a));
      const { pullCredentials } = await import("credvault");
      const { envStoreFor } = await import("./services.js");
      const r = await pullCredentials(
        envStoreFor(settings),
        credentialsFor(settings, { armed: false, shared: false }),
        sites,
        { ...CRED_ENV, ...(o.overwrite ? { overwrite: true } : {}) },
      );
      if (r.written.length) console.log(`pulled ${r.written.join(", ")}`);
      if (r.kept.length)
        console.log(`kept (already here; --overwrite to replace): ${r.kept.join(", ")}`);
      if (!r.written.length && !r.kept.length) console.log("nothing in the store");
    });
  creds
    .command("history <site>")
    .description(
      "Every state the site's credential has had (a version per change, kept in SSM): when, whose, which fields changed; never values",
    )
    .action(async (siteArg: string) => {
      const site = accountSite(siteArg);
      const { credentialHistoryFor } = await import("./services.js");
      const versions = await credentialHistoryFor(settings).versions(site);
      if (!versions.length) console.log(`no history for ${site} yet (it starts at the next write)`);
      for (const v of versions)
        console.log(
          `${v.version}\t${v.at ?? "?"}\t${maskAddress(v.username)}\t${v.changed.join(", ")}`,
        );
    });
  creds
    .command("restore <site> <version>")
    .description(
      "Put a kept version of the site's credential back, here and in SSM (itself a new version, so it can be undone too); shows what would change, --yes writes",
    )
    .option("--yes", "write it")
    .action(async (siteArg: string, version: string, o: { yes?: boolean }) => {
      const site = accountSite(siteArg);
      const { changedFields } = await import("credvault");
      const { credentialHistoryFor } = await import("./services.js");
      const n = Number(version);
      if (!Number.isInteger(n) || n < 1)
        throw new Error(`a version is a number (creds history ${site})`);
      const store = credentialsFor(settings, { armed: false });
      const kept = await credentialHistoryFor(settings).get(site, n);
      if (!kept) throw new Error(`${site} has no version ${n} (creds history ${site})`);
      const now = await store.get(site);
      const changes = now ? changedFields(now, kept) : ["all"];
      if (!changes.length) return console.log(`${site} already is version ${n}`);
      console.log(`${site} → version ${n} (${maskAddress(kept.username)}): ${changes.join(", ")}`);
      if (!o.yes) return console.log("nothing written; --yes to write");
      await store.put(site, kept);
      console.log("restored");
    });
  creds
    .command("rm <site>")
    .description(
      "Forget a stored credential, here and in the shared store (an address means its Google account); its history stays, so `creds restore` brings it back",
    )
    .action(async (siteArg: string) => {
      const site = accountSite(siteArg);
      const store = credentialsFor(settings, { armed: false });
      if (!store.remove) throw new Error("this credential store cannot forget");
      console.log(
        (await store.remove(site)) ? `forgot ${site}` : `no credential stored for ${site}`,
      );
    });
  creds
    .command("to-passwords <sites...>")
    .description(
      "Put the accounts in Apple Passwords, sorted: address, password and authenticator on one login each; iCloud syncs them to your iPhone, iPad and Macs. Nothing is shown",
    )
    .option(
      "--without-authenticator",
      "also add logins with no authenticator yet (Passwords never adds one to them later)",
    )
    .action(async (siteArgs: string[], o: { withoutAuthenticator?: boolean }) => {
      const { importIntoPasswords, otpauthUri } = await import("./apple-passwords.js");
      const store = credentialsFor(settings);
      const rows = [];
      for (const site of siteArgs.map((a) => accountSite(a))) {
        const cred = await store.get(site);
        if (!cred?.password) {
          console.log(`${site}: no password stored`);
          continue;
        }
        if (!cred.totpSecret && !o.withoutAuthenticator) {
          console.log(`${site}: skipped, no authenticator yet (autobrowse enroll-totp ${site})`);
          continue;
        }
        const provider = site.split("@")[0] ?? site;
        const issuer = provider.replace(/^./, (c) => c.toUpperCase());
        const login = resolveLogin(SITE_LOGINS, site);
        rows.push({
          title: `${issuer} (${cred.username})`,
          url: login?.home ?? `https://${provider}.com/`,
          username: cred.username,
          password: cred.password,
          notes: "added by autobrowse",
          ...(cred.totpSecret
            ? { otpauth: otpauthUri(issuer, cred.username, cred.totpSecret) }
            : {}),
        });
        console.log(
          `${site}: password${cred.totpSecret ? " + authenticator" : " only (no authenticator yet)"}`,
        );
      }
      if (!rows.length) return;
      const said = await importIntoPasswords(rows);
      console.log(`Passwords: ${said || "(no summary shown)"}`);
      console.log("an import never overwrites a login already there");
    });
  creds
    .command("list [platform]")
    .description(
      "Every stored account by platform: who it is (username), what it is for (roles: `creds role`), how it signs in; one platform when named",
    )
    .action(async (platform?: string) => {
      const rows = await accountsOn(credentialsFor(settings, { armed: false }), platform);
      console.log(
        rows.length ? formatAccounts(rows) : `no credentials${platform ? ` on ${platform}` : ""}`,
      );
    });
  creds
    .command("role <site> <role> [account]")
    .description(
      "Give an account a role on its site (main, alt, wren): `site@role` then names it. The role leaves the account that had it; `--drop` takes it off",
    )
    .option("--drop", "take the role off whichever account has it")
    .action(
      async (siteArg: string, role: string, account: string | undefined, o: { drop?: boolean }) => {
        const site = platformOf(accountSite(siteArg));
        const store = credentialsFor(settings, { armed: false });
        if (o.drop) {
          const had = await dropRole(store.stored, site, role);
          console.log(
            had ? `${site}@${role} dropped (was ${had})` : `no account on ${site} has ${role}`,
          );
          return;
        }
        const key = await pickAccount(store, site, account);
        const move = await giveRole(store.stored, key, role);
        for (const r of move.renamed)
          console.log(`${r.from} → ${r.to}${moveProfile(r.from, r.to)}`);
        const username = (await store.stored.get(key))?.username ?? key;
        console.log(
          `${site}@${role} is ${username}${move.took.length ? ` (was ${move.took.join(", ")})` : ""}`,
        );
      },
    );
  creds
    .command("canary <name>")
    .description(
      "Store a tripwire credential under a name a thief would reach for (stripe, bank); any read of it is an alarm in the ledger",
    )
    .option("--username <u>", "what it looks like", "billing@wrenautomation.com")
    .action(async (name: string, o: { username: string }) => {
      const { canaryCredential } = await import("credvault");
      await credentialsFor(settings, { armed: false }).put(name, canaryCredential(o.username));
      console.log(
        `canary ${name} armed: nothing legitimate reads it; \`creds audit\` shows a read`,
      );
    });

  creds
    .command("audit")
    .description(
      "Where secrets went: every fill of a password or placed secret, allowed or refused (never the value)",
    )
    .option("--last <n>", "how many lines", "50")
    .action(async (o: { last: string }) => {
      const { auditFor } = await import("./services.js");
      const uses = await auditFor(settings).recent(Number(o.last));
      if (!uses.length) console.log("no secret uses recorded yet");
      for (const u of uses) {
        console.log(
          `${u.at}\t${u.allowed ? "ok     " : "REFUSED"}\t${u.credential}.${u.field}\t${u.url}\t${u.by}`,
        );
      }
    });

  program
    .command("ledger")
    .description(
      "Check the hash chains of the ledgers (secret uses, spend decisions, agent steps): an edited, dropped or reordered row breaks every hash after it",
    )
    .argument("<verb>", "verify")
    .action(async (verb: string) => {
      if (verb !== "verify") throw new Error(`ledger: unknown verb ${verb}; verify`);
      const { ledgerPath } = await import("./services.js");
      const { verifyChain } = await import("credvault");
      let bad = 0;
      for (const name of ["audit", "spend", "steps"] as const) {
        const v = await verifyChain(ledgerPath(settings, name));
        if (!v.ok) bad++;
        console.log(
          `${name.padEnd(6)} ${v.rows} rows${v.unchained ? ` (${v.unchained} from before chaining)` : ""}  ${v.ok ? "chain intact" : `BROKEN at row ${v.brokenAt}; rows before it are intact`}`,
        );
      }
      if (bad) process.exitCode = 1;
    });

  program
    .command("steps")
    .description(
      "The agent step ledger: every step of every session (UI, `agent`, repair) with its model spend and time; never a page or a value",
    )
    .option("--last <n>", "how many lines", "50")
    .option("--session <id>", "one session only")
    .action(async (o: { last: string; session?: string }) => {
      const { stepLedgerFor } = await import("./services.js");
      const rows = (await stepLedgerFor(settings).recent(Number(o.last))).filter(
        (r) => !o.session || r.session === o.session,
      );
      if (!rows.length) console.log("no agent steps recorded yet");
      for (const r of rows) {
        console.log(
          `${r.at}\t${r.session}\t${r.site}\t${String(r.n).padStart(2)}\t${r.ok ? "ok    " : "failed"}\t${r.cmd.padEnd(8)}\t${r.inputTokens}+${r.outputTokens} tok\t${r.ms} ms\t${r.host}${r.error ? `\t${r.error}` : ""}`,
        );
      }
    });

  program
    .command("spend")
    .description("Every payment-gate decision: auto, person, denied, over the cap (SPEND_* policy)")
    .option("--last <n>", "how many lines", "50")
    .option(
      "--grant <site>",
      "a yes given ahead: the site's payment asks go through without a text until it lapses",
    )
    .option("--hours <n>", "how long the grant lasts", "2")
    .option("--max <amount>", "per purchase; an ask with no amount on it still texts you")
    .option("--note <words>", "who said so (kept in the ledger)")
    .option("--revoke <site>", "end the site's grants now")
    .action(
      async (o: {
        last: string;
        grant?: string;
        hours: string;
        max?: string;
        note?: string;
        revoke?: string;
      }) => {
        const { spendGrantsFor, spendLedgerFor, spendPolicyFor } = await import("./services.js");
        const { amountLine } = await import("../gates/spend.js");
        const grants = spendGrantsFor(settings);
        if (o.revoke) {
          console.log(`revoked ${await grants.revoke(o.revoke)} grant(s) on ${o.revoke}`);
          return;
        }
        if (o.grant) {
          if (!o.note) throw new Error("--grant needs --note: who said so");
          const at = new Date();
          const hours = Number(o.hours);
          if (!(hours > 0)) throw new Error("--hours must be a positive number");
          const until = new Date(at.getTime() + hours * 3_600_000).toISOString();
          const max = o.max === undefined ? null : Number(o.max);
          await grants.add({ site: o.grant, max, until, note: o.note, at: at.toISOString() });
          await spendLedgerFor(settings).record({
            at: at.toISOString(),
            site: o.grant,
            url: "",
            what: `grant until ${until}${max === null ? "" : ` up to ${max}`}: ${o.note}`,
            amount: null,
            decided: "granted",
            allowed: true,
          });
          console.log(
            `granted ${o.grant} until ${until}${max === null ? "" : `, up to ${max} a purchase`}`,
          );
          return;
        }
        const p = spendPolicyFor(settings);
        console.log(
          `policy: allow=${p.allow.join(",") || "-"} auto-yes-under=${p.autoYesUnder} daily-cap=${p.dailyCap} hard-cap=${p.hardCap ?? "-"}`,
        );
        for (const g of grants.list(new Date()))
          console.log(
            `grant: ${g.site} until ${g.until}${g.max === null ? "" : ` up to ${g.max}`} (${g.note})`,
          );
        const rows = await spendLedgerFor(settings).recent(Number(o.last));
        if (!rows.length) console.log("no gate decisions recorded yet");
        for (const r of rows) {
          console.log(
            `${r.at}\t${r.allowed ? "yes" : "no "}\t${r.decided}\t${r.site}\t${r.amount ? amountLine(r.amount) : "?"}\t${r.what}`,
          );
        }
      },
    );

  /** Open the site's home in its profile: a wall there is the sign-in; "signed in" when the home shows signed in. */
  const checkLogin = async (siteArg: string, headedRun: boolean): Promise<string> => {
    const site = accountSite(siteArg);
    const login = await loginOrVia(settings, site);
    const opts = await browserFor(settings, site, headedRun ? headed : undefined);
    const credName = login.credential ?? site;
    const cred = await credentialsFor(settings).get(credName);
    if (!cred && !headedRun)
      throw new Error(
        `no credential for ${site}: \`autobrowse creds set ${credName}\`, or --headed to log in by hand`,
      );
    const runner = flowRunner(opts, {
      login: loginFor(settings, gmailFor(settings)),
      captcha: captchaFor(settings),
      learnedScreens: fileScreens(expandHome(settings.screensFile)),
    });
    const check = defineFlow<undefined, string>({
      site,
      name: "login",
      async run(fp: FlowPage) {
        if (!login.home) fp.human(`no home page known for ${site}: creds via ${site} ... --url`);
        await fp.open(login.home); // a wall here triggers the sign-in
        // A single-page app draws its sign-in form after load: judge the page it settles on.
        await fp.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
        if (await login.loggedIn(fp)) return "signed in";
        if (!headedRun) fp.human("not signed in after opening the home page");
        console.log("log in, then close the browser window");
        await new Promise<void>((resolve) => fp.page.context().on("close", () => resolve()));
        return "closed";
      },
    });
    return runner.run(check, undefined);
  };

  program
    .command("login [site]")
    .description(
      `Sign in to a site with the stored credential (headless). With --headed and no credential, a person logs in and closes the window. Sites: ${KNOWN}, or any site stored with \`creds via\``,
    )
    .option("--headed", "show the browser")
    .option(
      "--all",
      "every stored account, one after another: the daily check that keeps sessions warm and meets a changed page on a quiet run, not mid-task",
    )
    .action(async (siteArg: string | undefined, o: { headed?: boolean; all?: boolean }) => {
      if (!o.all) {
        if (!siteArg) throw new Error("login <site>, or login --all");
        console.log(await checkLogin(siteArg, o.headed === true));
        return;
      }
      const store = credentialsFor(settings);
      let failed = 0;
      for (const name of await store.list()) {
        const cred = await store.get(name).catch(() => null);
        if (!cred || cred.canary) continue;
        const got = await checkLogin(name, false).catch((err: unknown) => {
          failed += 1;
          return `FAILED: ${err instanceof Error ? err.message : String(err)}`;
        });
        console.log(`${name}: ${got}`);
      }
      if (failed) process.exitCode = 1;
    });

  program
    .command("workspace-logo <file>")
    .description("Set the Google Workspace logo (admin console; 320×132 PNG under 30 KB)")
    .option("--headed", "show the browser")
    .action(async (file: string, o: { headed?: boolean }) => {
      const { googleWorkspaceLogo } = await import("../browser/flows/google-workspace-logo.js");
      const runner = flowRunner(browserOptions(settings, o.headed ? headed : undefined), {
        login: loginFor(settings, gmailFor(settings)),
        captcha: captchaFor(settings),
      });
      console.log(await runner.run(googleWorkspaceLogo, { file: resolve(file) }));
    });

  program
    .command("profile-photo <file>")
    .description(
      "Set a Google account's profile picture (the round one beside its name in Gmail); a GIF stays animated",
    )
    .option(
      "--as <account>",
      "whose picture: an address (will@a.com) or a profile (google@wren)",
      "google",
    )
    .option("--headed", "show the browser")
    .action(async (file: string, o: { as: string; headed?: boolean }) => {
      const { googleProfilePhoto } = await import("../browser/flows/google-profile-photo.js");
      const runner = flowRunner(browserOptions(settings, o.headed ? headed : undefined), {
        login: loginFor(settings, gmailFor(settings)),
        captcha: captchaFor(settings),
      });
      console.log(
        await runner.run(
          { ...googleProfilePhoto, site: accountSite(o.as) },
          { file: resolve(file) },
        ),
      );
    });

  program
    .command("enroll-passkey <site>")
    .description(
      "Create a passkey on the site with our own authenticator and keep it; sign-ins then need no password or code",
    )
    .option("--headed", "show the browser")
    .action(async (siteArg: string, o: { headed?: boolean }) => {
      const site = accountSite(siteArg);
      const login = loginNamed(site);
      const runner = flowRunner(browserOptions(settings, o.headed ? headed : undefined), {
        login: loginFor(settings, gmailFor(settings)),
        captcha: captchaFor(settings),
      });
      console.log(await runner.run(enrollPasskeyFlow(login, credentialsFor(settings)), undefined));
    });

  program
    .command("recovery-codes <site>")
    .description(
      "Read the account's recovery codes off the site's recovery page and seal them with the credential; prints only how many",
    )
    .option("--headed", "show the browser")
    .action(async (siteArg: string, o: { headed?: boolean }) => {
      const site = accountSite(siteArg);
      const login = loginNamed(site);
      const runner = flowRunner(browserOptions(settings, o.headed ? headed : undefined), {
        login: loginFor(settings, gmailFor(settings)),
        captcha: captchaFor(settings),
      });
      console.log(
        await runner.run(sealRecoveryCodesFlow(login, credentialsFor(settings)), undefined),
      );
    });

  program
    .command("enroll-totp <sites...>")
    .description(
      "Turn on an authenticator for the site ourselves: read the seed off its setup page, store it sealed, confirm with a generated code",
    )
    .option("--url <url>", "the two-factor setup page, when the site's walk is not known")
    .option("--headed", "show the browser")
    .action(async (siteArgs: string[], o: { url?: string; headed?: boolean }) => {
      const runner = flowRunner(browserOptions(settings, o.headed ? headed : undefined), {
        login: loginFor(settings, gmailFor(settings)),
        captcha: captchaFor(settings),
      });
      // One account at a time; one failing does not stop the rest.
      for (const site of siteArgs.map((a) => accountSite(a))) {
        const login = resolveLogin(SITE_LOGINS, site) ?? { site };
        const got = await runner
          .run(enrollTotpFlow(login, credentialsFor(settings), o.url), undefined)
          .then(String)
          .catch((err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log(siteArgs.length > 1 ? `${site}: ${got}` : got);
      }
    });
}
