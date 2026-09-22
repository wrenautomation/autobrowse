/**
 * `autobrowse creds …`, `autobrowse login <site>`, `autobrowse enroll-totp
 * <site>`: the credential ladder from the terminal. Values arrive on
 * stdin, never as arguments (argv is visible to every process).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import {
  credentialSchema,
  enrollPasskeyFlow,
  enrollTotpFlow,
  ingest,
  isProvider,
  PROVIDERS,
  parseCredentialLines,
  resolveLogin,
  rotatePasswordFlow,
  SITE_LOGINS,
  takeClipboard,
  takeFile,
  viaLogin,
} from "../auth/index.js";
import { defineFlow, type FlowPage, flowRunner } from "../browser/flow.js";

/** A copied secret lives on the clipboard for a minute, then is emptied if untouched. */
const CLIPBOARD_MS = 60_000;

import { macClipboard } from "./cli-env.js";
import type { Settings } from "./config.js";
import { askSecretTwice } from "./prompt.js";
import { headed } from "./screen.js";
import {
  browserFor,
  browserOptions,
  credentialsFor,
  devicesFor,
  gmailFor,
  loginFor,
} from "./services.js";

const SITES = SITE_LOGINS.map((s) => s.site);
const KNOWN = `one of ${SITES.join(", ")}, or <site>@<account> for a second account`;

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
  creds
    .command("set <site>")
    .description(
      'Store a credential from stdin JSON: {"username","password","totpSecret"?,"codesInbox"?}',
    )
    .action(async (site: string) => {
      const raw = JSON.parse(readFileSync(0, "utf8"));
      const parsed = credentialSchema.safeParse(raw);
      if (!parsed.success) {
        for (const i of parsed.error.issues) console.error(`${i.path.join(".")}: ${i.message}`);
        process.exitCode = 1;
        return;
      }
      await credentialsFor(settings).put(site, parsed.data);
      console.log(`stored credential for ${site}`);
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
        await store.put(site, {
          username: account ?? providerCred.username,
          via: provider,
          ...(o.url ? { url: o.url } : {}),
        });
        console.log(`${site} signs in via ${provider}${o.url ? ` at ${o.url}` : ""}`);
      },
    );
  creds
    .command("made <site>")
    .description(
      "The account behind a minted signup credential exists now (you finished the signup by hand): `needs` stops asking for it",
    )
    .action(async (site: string) => {
      const store = credentialsFor(settings);
      const cred = await store.get(site);
      if (!cred)
        throw new Error(`no credential stored for ${site}: autobrowse signup ${site} first`);
      await store.put(site, { ...cred, madeAt: new Date().toISOString() });
      console.log(`${site}: marked made; creds push ${site} sends it to the box`);
    });
  creds
    .command("address <site> <address>")
    .description(
      "The account's sign-in address changed on the site: the stored username follows it, and its codes are read from that inbox",
    )
    .action(async (site: string, address: string) => {
      const store = credentialsFor(settings);
      const cred = await store.get(site);
      if (!cred) throw new Error(`no credential stored for ${site}`);
      await store.put(site, { ...cred, username: address, codesInbox: address });
      console.log(`${site}: username and codes inbox set; creds push ${site} sends it to the box`);
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
    .action(async (site: string, o: { headed?: boolean; ask?: boolean }) => {
      const login = loginNamed(site);
      // Asked for before the browser opens, so a typo costs nothing.
      const chosen = o.ask ? await askSecretTwice(`new password for ${site}`) : null;
      const runner = flowRunner(browserOptions(settings, o.headed ? headed : undefined), {
        login: loginFor(settings, gmailFor(settings)),
      });
      const flow = chosen
        ? rotatePasswordFlow(login, credentialsFor(settings), () => chosen)
        : rotatePasswordFlow(login, credentialsFor(settings));
      console.log(await runner.run(flow, undefined));
    });
  creds
    .command("password <site>")
    .description(
      "The password changed on the site (you changed it by hand): type it here, twice, never echoed; only the store is touched, no browser",
    )
    .action(async (site: string) => {
      const store = credentialsFor(settings);
      const cred = await store.get(site);
      if (!cred) throw new Error(`no credential stored for ${site}`);
      const next = await askSecretTwice(`password for ${site}`);
      await store.put(site, {
        ...cred,
        password: next,
        ...(cred.password ? { previousPassword: cred.password } : {}),
      });
      console.log(`${site}: stored; creds push ${site} sends it to the box`);
    });
  creds
    .command("copy <site>")
    .description(
      "One field of a stored credential onto the clipboard (emptied after a minute); nothing is ever printed",
    )
    .option("--field <what>", "password | username | totp | recovery | previous", "password")
    .action(async (site: string, o: { field: string }) => {
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
      console.log(`${site} ${o.field} is on the clipboard for ${CLIPBOARD_MS / 1000}s`);
    });
  creds
    .command("paste <site>")
    .description(
      "Store what is on the clipboard: `email password [authenticator key]`; the clipboard is emptied after",
    )
    .action(async (site: string) => {
      const lines = parseCredentialLines(takeClipboard(), site);
      if (lines.length !== 1) throw new Error("the clipboard must hold exactly one line");
      console.log(`stored: ${(await ingest(credentialsFor(settings), lines)).join(", ")}`);
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
      "This machine's stored credentials into the env store (SSM) as AUTOBROWSE_CRED_<SITE>_*, so the box signs in too; --all for every site; nothing printed",
    )
    .option("--all", "every stored site (canaries never travel)")
    .action(async (sites: string[], o: { all?: boolean }) => {
      if (sites.length === 0 && !o.all) throw new Error("name sites, or --all");
      const { pushCredentials } = await import("../auth/credentials.js");
      const { envStoreFor } = await import("./services.js");
      // Unarmed: the push reads every site to skip the canaries; an armed read of one would trip it.
      const pushed = await pushCredentials(
        credentialsFor(settings, { armed: false }),
        envStoreFor(settings),
        sites,
      );
      for (const p of pushed) console.log(`pushed ${p.site}: ${p.names.join(", ")}`);
      console.log("the box reads the store on its next deploy (push to main)");
    });
  creds
    .command("pull [sites...]")
    .description(
      "Credentials from the env store into this machine's sealed file (a second laptop); a site already here is kept unless --overwrite; passkeys and recovery codes here always stay",
    )
    .option("--overwrite", "replace what is here with the store's username/password/TOTP/via")
    .action(async (sites: string[], o: { overwrite?: boolean }) => {
      const { pullCredentials } = await import("../auth/credentials.js");
      const { envStoreFor } = await import("./services.js");
      const r = await pullCredentials(
        envStoreFor(settings),
        credentialsFor(settings, { armed: false }),
        sites,
        {
          ...(o.overwrite ? { overwrite: true } : {}),
        },
      );
      if (r.written.length) console.log(`pulled ${r.written.join(", ")}`);
      if (r.kept.length)
        console.log(`kept (already here; --overwrite to replace): ${r.kept.join(", ")}`);
      if (!r.written.length && !r.kept.length) console.log("nothing in the store");
    });
  creds
    .command("list")
    .description("Sites with a stored credential (names only)")
    .action(async () => {
      const store = credentialsFor(settings, { armed: false });
      for (const site of await store.list()) {
        const c = await store.get(site);
        console.log(
          `${site}\t${c?.canary ? "CANARY" : c?.via ? `via ${c.via}` : c?.totpSecret ? "totp" : "no totp"}`,
        );
      }
    });
  creds
    .command("canary <name>")
    .description(
      "Store a tripwire credential under a name a thief would reach for (stripe, bank); any read of it is an alarm in the ledger",
    )
    .option("--username <u>", "what it looks like", "billing@wrenautomation.com")
    .action(async (name: string, o: { username: string }) => {
      const { canaryCredential } = await import("../auth/canary.js");
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
      const { verifyChain } = await import("../deps/chain.js");
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
    .action(async (o: { last: string }) => {
      const { spendLedgerFor, spendPolicyFor } = await import("./services.js");
      const { amountLine } = await import("../gates/spend.js");
      const p = spendPolicyFor(settings);
      console.log(
        `policy: allow=${p.allow.join(",") || "-"} auto-yes-under=${p.autoYesUnder} daily-cap=${p.dailyCap} hard-cap=${p.hardCap ?? "-"}`,
      );
      const rows = await spendLedgerFor(settings).recent(Number(o.last));
      if (!rows.length) console.log("no gate decisions recorded yet");
      for (const r of rows) {
        console.log(
          `${r.at}\t${r.allowed ? "yes" : "no "}\t${r.decided}\t${r.site}\t${r.amount ? amountLine(r.amount) : "?"}\t${r.what}`,
        );
      }
    });

  program
    .command("login <site>")
    .description(
      `Sign in to a site with the stored credential (headless). With --headed and no credential, a person logs in and closes the window. Sites: ${KNOWN}, or any site stored with \`creds via\``,
    )
    .option("--headed", "show the browser")
    .action(async (site: string, o: { headed?: boolean }) => {
      const login = await loginOrVia(settings, site);
      const opts = await browserFor(settings, site, o.headed ? headed : undefined);
      const credName = login.credential ?? site;
      const cred = await credentialsFor(settings).get(credName);
      if (!cred && !o.headed)
        throw new Error(
          `no credential for ${site}: \`autobrowse creds set ${credName}\`, or --headed to log in by hand`,
        );
      const runner = flowRunner(opts, { login: loginFor(settings, gmailFor(settings)) });
      const check = defineFlow<undefined, string>({
        site,
        name: "login",
        async run(fp: FlowPage) {
          if (!login.home) fp.human(`no home page known for ${site}: creds via ${site} ... --url`);
          await fp.open(login.home); // a wall here triggers the sign-in
          if (await login.loggedIn(fp)) return "signed in";
          if (!o.headed) fp.human("not signed in after opening the home page");
          console.log("log in, then close the browser window");
          await new Promise<void>((resolve) => fp.page.context().on("close", () => resolve()));
          return "closed";
        },
      });
      console.log(await runner.run(check, undefined));
    });

  program
    .command("workspace-logo <file>")
    .description("Set the Google Workspace logo (admin console; 320×132 PNG under 30 KB)")
    .option("--headed", "show the browser")
    .action(async (file: string, o: { headed?: boolean }) => {
      const { googleWorkspaceLogo } = await import("../browser/flows/google-workspace-logo.js");
      const runner = flowRunner(browserOptions(settings, o.headed ? headed : undefined), {
        login: loginFor(settings, gmailFor(settings)),
      });
      console.log(await runner.run(googleWorkspaceLogo, { file: resolve(file) }));
    });

  program
    .command("enroll-passkey <site>")
    .description(
      "Create a passkey on the site with our own authenticator and keep it; sign-ins then need no password or code",
    )
    .option("--headed", "show the browser")
    .action(async (site: string, o: { headed?: boolean }) => {
      const login = loginNamed(site);
      const runner = flowRunner(browserOptions(settings, o.headed ? headed : undefined), {
        login: loginFor(settings, gmailFor(settings)),
      });
      console.log(await runner.run(enrollPasskeyFlow(login, credentialsFor(settings)), undefined));
    });

  program
    .command("enroll-totp <site>")
    .description(
      "Turn on an authenticator for the site ourselves: read the seed off its setup page, store it sealed, confirm with a generated code",
    )
    .option("--url <url>", "the two-factor setup page, when the site's walk is not known")
    .option("--headed", "show the browser")
    .action(async (site: string, o: { url?: string; headed?: boolean }) => {
      const login = resolveLogin(SITE_LOGINS, site) ?? { site };
      const runner = flowRunner(browserOptions(settings, o.headed ? headed : undefined), {
        login: loginFor(settings, gmailFor(settings)),
      });
      console.log(
        await runner.run(enrollTotpFlow(login, credentialsFor(settings), o.url), undefined),
      );
    });
}
