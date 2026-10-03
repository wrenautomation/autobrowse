/**
 * `autobrowse accounts`: which of the person's accounts is for what, and how
 * ready each is (a stored credential, a readable inbox, kept tokens). The
 * policy every signup, consent and `via` sign-in reads when nothing names an
 * account. Addresses and names only; never a value.
 */
import type { Command } from "commander";
import type { CredentialStore } from "credvault";
import {
  assignPurpose,
  DEFAULT_PURPOSE,
  IDENTITY_PROVIDERS,
  type Identity,
  type IdentityStore,
  identitySchema,
  inGroup,
  isExclusive,
  PURPOSES,
  withIdentity,
  withoutIdentity,
} from "../auth/identities.js";
import { gmailOAuth } from "../sites/gmail.js";
import { accountEnv } from "../sites/oauth.js";
import { profileOf } from "../sites/wire.js";
import { bad, bold, columns, dim, good } from "../style.js";

export interface AccountsCliDeps {
  identities: IdentityStore;
  /** Unarmed: this listing reads every `<site>@<label>` credential to find the one for an address. */
  credentials: CredentialStore;
  env: (name: string) => string | undefined;
  /** Env names in hand, to find tokens kept under an account's name. */
  envNames: () => string[];
  /** The service account's Workspace domain, whose inboxes it reads; null without one. */
  workspaceDomain: string | null;
  push: (text: string) => Promise<void>;
}

export interface AccountReadiness {
  address: string;
  at: Identity["at"];
  for: string[];
  /** The `<site>@<label>` credential whose username this is; null when none is stored. */
  credential: string | null;
  /** How its inbox is read for codes, or null when it cannot be yet. */
  inbox: "consented" | "service account" | null;
  /** Base names of tokens kept under this account (`YOUTUBE_REFRESH_TOKEN`). */
  tokens: string[];
}

export async function readiness(deps: AccountsCliDeps, id: Identity): Promise<AccountReadiness> {
  const suffix = accountEnv("", id.address);
  const domain = id.address.split("@")[1]?.toLowerCase() ?? "";
  const gmailConsented = Boolean(deps.env(accountEnv(gmailOAuth.refreshToken, id.address)));
  return {
    address: id.address,
    at: id.at,
    for: id.for,
    credential: await profileOf(deps.credentials, id.at, id.address),
    inbox:
      id.at !== "google"
        ? null
        : gmailConsented
          ? "consented"
          : deps.workspaceDomain && domain === deps.workspaceDomain
            ? "service account"
            : null,
    tokens: deps
      .envNames()
      .filter((n) => n.endsWith(suffix))
      .map((n) => n.slice(0, -suffix.length))
      .sort(),
  };
}

/** One row per account: its purposes, then ✓/✗ for a login, a readable inbox, kept tokens; a fix line under the table for each ✗. */
export function formatReadiness(rows: AccountReadiness[]): string {
  if (!rows.length)
    return [
      "no accounts yet: autobrowse accounts add <address...> --for pays|default|signup|<group>",
      ...Object.entries(PURPOSES).map(([k, v]) => `  ${k.padEnd(8)} ${v}`),
      "  <group>  any other word (sends): as many accounts as you like",
    ].join("\n");
  const yes = good("✓");
  const no = bad("✗");
  // `YOUTUBE_REFRESH_TOKEN` → `youtube`: the site is what a reader looks for.
  const site = (t: string) => t.replace(/_(REFRESH|ACCESS)_TOKEN$|_TOKEN$/, "").toLowerCase();
  const table = rows.map((r) => [
    r.address,
    r.at,
    r.for.join(", ") || "(nothing)",
    r.credential ? yes : no,
    r.inbox === "consented" ? `${yes} consent` : r.inbox ? `${yes} delegated` : no,
    r.tokens.map(site).join(", ") || "-",
  ]);
  const head = ["account", "at", "for", "login", "inbox", "tokens"];
  const text = columns([head, ...table]);
  const lines = [bold(text[0] ?? ""), ...text.slice(1)];
  const fixes: string[] = [];
  if (rows.some((r) => !r.credential))
    fixes.push(`${no} login: ${dim("autobrowse creds paste <address>")}`);
  if (rows.some((r) => !r.inbox && r.at === "google"))
    fixes.push(`${no} inbox: ${dim("autobrowse site setup gmail consent --account <address>")}`);
  return [...lines, ...(fixes.length ? ["", ...fixes] : [])].join("\n");
}

export function registerAccountsCommands(program: Command, deps: () => AccountsCliDeps): void {
  const accounts = program
    .command("accounts")
    .description(
      "Which of your accounts is for what (pays, default, signup, …): the policy every signup, consent and via sign-in reads",
    );
  accounts
    .command("list", { isDefault: true })
    .description(
      "Each account, its purposes, and how ready it is; nothing secret. --for <purpose> shows one group",
    )
    .option("--for <purpose>", "only the accounts for this (sends, pays, …)")
    .action(async (o: { for?: string }) => {
      const d = deps();
      const all = await d.identities.list();
      const shown = o.for ? inGroup(all, o.for) : all;
      const rows = [];
      for (const id of shown) rows.push(await readiness(d, id));
      if (o.for && !rows.length) return console.log(`no account is for ${o.for}`);
      console.log(formatReadiness(rows));
      if (o.for) console.log(`${rows.length} for ${o.for}`);
    });
  accounts
    .command("add <addresses...>")
    .description(
      "Add or change accounts, several at once (a group of senders); pays, default and signup move to the account named, any other purpose is shared",
    )
    .option(
      "--for <purposes>",
      "comma-separated: pays, default, signup, or your own group word",
      "",
    )
    .option("--at <provider>", `where it signs in: ${IDENTITY_PROVIDERS.join("|")}`, "google")
    .option("--note <text>", "what it is, in your words")
    .action(async (addresses: string[], o: { for: string; at: string; note?: string }) => {
      const d = deps();
      const purposes = o.for
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const sole = purposes.filter(isExclusive);
      if (sole.length && addresses.length > 1)
        throw new Error(`${sole.join(", ")} is one account's: add one address for it`);
      const bad = addresses.filter((a) => !identitySchema.shape.address.safeParse(a).success);
      if (bad.length) throw new Error(`not an email address: ${bad.join(", ")}`);
      let all = await d.identities.list();
      for (const address of addresses) {
        const had = all.find((i) => i.address.toLowerCase() === address.trim().toLowerCase());
        const id = identitySchema.parse({
          address,
          at: o.at,
          // Adding a purpose keeps the ones it had; a note replaces.
          for: [...new Set([...(had?.for ?? []), ...purposes])],
          ...(o.note ? { note: o.note } : had?.note ? { note: had.note } : {}),
        });
        all = withIdentity(all, id);
        console.log(`${id.address}: for ${id.for.join(",") || "(nothing yet)"}`);
      }
      await d.identities.save(all);
      if (!all.some((i) => i.for.includes(DEFAULT_PURPOSE)))
        console.log(`no account is the default yet: accounts use default <address>`);
    });
  accounts
    .command("use <purpose> <address>")
    .description(
      "Give a purpose to an account already listed (pays, default and signup move from whichever had it)",
    )
    .action(async (purpose: string, address: string) => {
      const d = deps();
      await d.identities.save(assignPurpose(await d.identities.list(), purpose, address));
      console.log(`${purpose} → ${address}`);
    });
  accounts
    .command("drop <purpose> <address>")
    .description("Take one purpose off an account; the account stays")
    .action(async (purpose: string, address: string) => {
      const d = deps();
      const all = await d.identities.list();
      const id = all.find((i) => i.address.toLowerCase() === address.trim().toLowerCase());
      if (!id) throw new Error(`no account ${address}`);
      await d.identities.save(
        withIdentity(all, { ...id, for: id.for.filter((p) => p !== purpose) }),
      );
      console.log(
        `${id.address}: for ${id.for.filter((p) => p !== purpose).join(",") || "(nothing)"}`,
      );
    });
  accounts
    .command("remove <address>")
    .description(
      "Forget an account (its credential and tokens stay where they are: creds rm <address> for the credential)",
    )
    .action(async (address: string) => {
      const d = deps();
      await d.identities.save(withoutIdentity(await d.identities.list(), address));
      console.log(`removed ${address}`);
    });
  accounts
    .command("push")
    .description("This policy into the env store as AUTOBROWSE_ACCOUNTS, so the box follows it too")
    .action(async () => {
      const d = deps();
      const { formatIdentities } = await import("../auth/identities.js");
      const all = await d.identities.list();
      await d.push(formatIdentities(all));
      console.log(`pushed ${all.length} account(s); the box reads it on its next deploy`);
    });
}
