/**
 * `autobrowse --help` as a reader scans it: commands in groups, one short
 * line each, no `[options]` noise; a command's own list gives each
 * subcommand its first clause. `autobrowse help <command>` keeps the whole
 * description.
 */

import type { Command } from "commander";

/** Groups in print order; each command with its one line. A command missing here lands in "More" with its own description. */
const GROUPS: [string, [string, string][]][] = [
  [
    "Do things",
    [
      ["do", "Say what you want; it routes there or builds it"],
      ["abilities", "Everything `do` can pick from"],
      ["workflows", "What this worker can run; a name shows steps, inputs"],
      ["flows", "Every deterministic browser leg"],
      ["run", "Start a run from a plan"],
      ["try", "Run a workflow here, no Restate"],
      ["runs", "Runs, newest first"],
      ["status", "Where a run is"],
    ],
  ],
  [
    "Steer a run",
    [
      ["approve", "Say yes at a run's gate"],
      ["reject", "Say no at a run's gate"],
      ["pause", "Pause a run"],
      ["play", "Resume a paused run"],
      ["reset", "Forget everything about a run"],
    ],
  ],
  [
    "Sites and the web",
    [
      ["site", "Services in their official API's shape"],
      ["login", "Sign in to a site with its stored login"],
      ["signup", "Make an account (password minted and sealed)"],
      ["known", "Does this address already have an account there?"],
      ["read", "A page as plain text"],
      ["search", "Web search"],
      ["maps", "Google Maps listings → lead CSV"],
      ["people", "LinkedIn people → lead CSV (as Wren)"],
      ["unsubscribe", "Mailing lists an inbox is on; --yes leaves"],
      ["inbox-accounts", "Give a sending inbox its free accounts"],
    ],
  ],
  [
    "Domains and mail",
    [
      ["domain", "Provision a sending domain end to end"],
      ["redirect", "301 a domain to the main site"],
      ["domains", "Domain ideas with Cloudflare prices"],
      ["inbox-name", "Set a Workspace inbox's display name"],
      ["inbox-photo", "Set a Workspace inbox's picture"],
      ["warmup-match", "Copy one Instantly inbox's warmup to others"],
      ["workspace-logo", "Set the Workspace logo"],
      ["profile-photo", "Set a Google account's profile picture"],
    ],
  ],
  [
    "Accounts and secrets",
    [
      ["needs", "What only you can give, and the command for each"],
      ["setup", "Ask once for missing root credentials"],
      ["accounts", "Which address is for what (pays, sends, …)"],
      ["creds", "Site logins: who, what for, how it signs in"],
      ["env", "Secrets in and out of SSM"],
      ["access", "What each agent may use"],
      ["enroll-passkey", "Make a passkey on a site and keep it"],
      ["enroll-totp", "Turn on an authenticator, seal its seed"],
      ["recovery-codes", "Read and seal an account's recovery codes"],
      ["aws-login", "`aws login`, answered from the browser"],
      ["wrangler-login", "`wrangler login`, authorized from the browser"],
      ["gcloud-login", "`gcloud auth login`, answered from the browser"],
      ["cloudflare-token", "Mint and store a Cloudflare API token"],
    ],
  ],
  [
    "Money",
    [
      ["wallet", "Cards: credit pays, debit only where allowed"],
      ["profile", "Who you are and where cards bill"],
      ["spend", "Every payment-gate decision"],
      ["ledger", "Check the ledgers' hash chains"],
    ],
  ],
  [
    "Build and fix flows",
    [
      ["explore", "Hold a browser open, drive it over loopback"],
      ["agent", "An agent explores toward a goal"],
      ["record", "Record a chore in a headed browser"],
      ["compile", "Recording → workflow module"],
      ["finish", "A model finishes a compiled workflow"],
      ["repair", "An agent picks up a stopped flow"],
      ["heal", "Fix a failed compiled step, prove it again"],
      ["walks", "Flows built from runs that reached a goal"],
      ["explored", "Explore runs, newest last"],
      ["watched", "What a watched flow did, step by step"],
      ["repairs", "Locators fixed at run time"],
      ["screens", "Pages learned on each site"],
      ["mcp", "Serve autobrowse as MCP tools"],
    ],
  ],
  [
    "This machine",
    [
      ["doctor", "What answers right now"],
      ["tokens", "Token spend by purpose"],
      ["steps", "Every agent step, with its spend"],
      ["fingerprint", "How a browser looks to bot checks"],
      ["reap", "Stop browsers whose owner died"],
      ["shots", "Screenshots kept in the bucket"],
      ["desktop", "Apps, menus and dialogs outside the browser"],
      ["langfuse", "Langfuse as the trace back end"],
    ],
  ],
];

const term = (c: Command): string =>
  [
    c.name(),
    ...c.registeredArguments.map((a) => {
      const n = `${a.name()}${a.variadic ? "..." : ""}`;
      return a.required ? `<${n}>` : `[${n}]`;
    }),
  ].join(" ");

/**
 * A subcommand's line in its parent's list: the description up to its first
 * `:`, `;` or `. ` outside brackets ("Store a credential from stdin JSON: {…}"
 * → "Store a credential from stdin JSON").
 */
export function firstClause(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i) i = close;
    } else if (
      depth === 0 &&
      (c === ":" || c === ";" || c === ".") &&
      /\s/.test(text[i + 1] ?? " ")
    )
      return text.slice(0, i);
  }
  return text;
}

/** Call once every command is registered. */
export function tidyHelp(program: Command): void {
  const placed = new Map<string, { group: string; line: string; rank: number }>();
  GROUPS.forEach(([group, rows], g) => {
    rows.forEach(([name, line], i) => {
      placed.set(name, { group: `${group}:`, line, rank: g * 100 + i });
    });
  });
  const rank = (c: Command) => placed.get(c.name())?.rank ?? Number.MAX_SAFE_INTEGER;
  for (const c of program.commands) {
    const p = placed.get(c.name());
    c.helpGroup(p?.group ?? "More:");
    if (p) c.summary(p.line);
  }
  const commands = program.commands as Command[];
  commands.sort((a, b) => rank(a) - rank(b));
  program.configureHelp({ subcommandTerm: term });
  const nested = (c: Command): void => {
    if (!c.commands.length) return;
    c.configureHelp({
      subcommandTerm: term,
      subcommandDescription: (sub) => sub.summary() || firstClause(sub.description()),
    });
    for (const sub of c.commands) nested(sub);
  };
  for (const c of commands) nested(c);
}
