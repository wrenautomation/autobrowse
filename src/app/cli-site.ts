/**
 * `autobrowse site`: the site APIs from the terminal, on the same Backend
 * the HTTP face serves. `site` lists them, `site <name>` says what answers
 * and what setup is left, `site <name> call` is one official call, `site
 * <name> setup <step>` makes a key or token, `site check` proves each token live,
 * `site caps` says who spent a day's capped reads, `site revoke` ends a grant and
 * queues its re-make. A token a platform refused is shown plainly, with since when.
 */

import type { Command } from "commander";
import { RETRY_BUFFER } from "../sites/caps.js";
import type { CapsReport, LimitsRow } from "../sites/facade.js";
import { type CheckRow, checkSite, type Method } from "../sites/index.js";
import type { SiteLimits } from "../sites/limits.js";
import { refusedLine, utcOf } from "../sites/refused.js";
import { accent, bad, bold, columns, dim, good, warn } from "../style.js";
import type { LocalBackend } from "./backend.js";
import { readJson } from "./cli-json.js";
import type { Ingress } from "./client.js";

/** `will@wren.com` → `w…@wren.com`: an account named without spelling it out. */
const maskAddress = (a: string) => a.replace(/^([^@])[^@]*@/, "$1…@");

/** Each bucket's use, then each caller's calls by route and outcome; `--rows` lists them. */
export function printCaps(r: CapsReport, rows: boolean): void {
  console.log(`caps ${r.day} (UTC)`);
  const used = Object.entries(r.used).sort();
  if (!used.length) console.log("  nothing used");
  for (const [k, n] of used) {
    const [site, account, bucket] = k.split("|");
    // a box from before 2026-10-29 sends no tries
    const t = r.tried?.[k] ?? n;
    console.log(
      `  ${site} ${maskAddress(account ?? "")} ${bucket}: ${n}${t > n ? ` (${t} tries)` : ""}`,
    );
  }
  const groups = new Map<string, number>();
  for (const c of r.calls) {
    const spent = c.outcome === "failed" && c.spent === false ? " unspent" : "";
    const k = `${c.caller ?? "(unnamed)"}  ${c.site} ${maskAddress(c.account)}  ${c.route}  ${c.outcome}${spent}${c.bucket ? ` ${c.bucket}` : ""}`;
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  console.log(`calls: ${r.calls.length}`);
  for (const [k, n] of [...groups].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  if (rows)
    for (const c of r.calls)
      console.log(
        `  ${c.at.slice(11, 19)} ${c.caller ?? "(unnamed)"} ${c.route} ${c.outcome}${c.invocation ? ` ${c.invocation}` : ""}`,
      );
}

/** One site's who-am-I answer as cells: green when it answers, dim with no probe to try, red with why not. */
export const checkRow = (c: CheckRow): string[] => [
  accent(c.site),
  c.ok ? good(`ok ${c.ms}ms`) : c.why === "no probe" ? dim(c.why) : bad(c.why ?? "failed"),
];

const secs = (ms: number) => `${ms / 1000}s`;

/** One site's limits: `*` marks a value `limits.json` sets; then today's use per account. */
export function printLimits(r: LimitsRow, used: Record<string, number>): void {
  const mark = (on: boolean) => (on ? warn("*") : "");
  const line = (caps: Record<string, number>, set: Record<string, number> = {}) =>
    Object.entries(caps)
      .map(([b, n]) => `${b} ${n}${mark(b in set)}`)
      .join("  ");
  const pace = r.pace
    ? `pace ${secs(r.pace.gapMs)}${r.pace.jitterMs ? ` + up to ${secs(r.pace.jitterMs)}` : ""}${mark(Boolean(r.set.pace))}`
    : "no pace";
  const buffer = `retries +${Math.round((r.retryBuffer ?? RETRY_BUFFER.act) * 100)}%${r.retryBuffer === undefined ? ` acts, +${RETRY_BUFFER.read * 100}% reads` : ""}${mark(r.set.retryBuffer !== undefined)}`;
  console.log(`${accent(r.site)}  ${pace}  ${buffer}`);
  if (r.caps) console.log(`  caps  ${line(r.caps, r.set.caps)}`);
  for (const [name, caps] of Object.entries(r.accountCaps ?? {}))
    console.log(`  account ${name}  ${line(caps, r.set.accounts?.[name])}`);
  const today = new Map<string, string[]>();
  for (const [k, n] of Object.entries(used).sort()) {
    const [, account = "", bucket] = k.split("|");
    today.set(account, [...(today.get(account) ?? []), `${bucket} ${n}`]);
  }
  for (const [account, parts] of today)
    console.log(dim(`  used today by ${maskAddress(account)}  ${parts.join("  ")}`));
}

function registerLimitCommands(program: Command, local: LocalBackend): void {
  const facade = () => {
    const sites = local().backend.sites;
    if (!sites) throw new Error("no site apis here");
    return sites;
  };
  const edit = (name: string, fn: (l: SiteLimits) => SiteLimits) => {
    const { before, after, path } = facade().editLimits(name, fn);
    console.log(`${path}: ${name} ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  };
  const count = (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${v}: a whole number, 0 or more`);
    return n;
  };
  const limits = program
    .command("limits [site]")
    .description(
      "Each site's daily caps, each account's own caps and the pace between calls; * marks what limits.json sets over the code's defaults",
    )
    .option("--json", "the rows as JSON")
    .action((name: string | undefined, o: { json?: boolean }) => {
      const sites = facade();
      const rows = sites.limits(name);
      if (o.json) return console.log(JSON.stringify(rows, null, 2));
      const { used } = sites.caps(undefined, name);
      for (const r of rows)
        printLimits(
          r,
          Object.fromEntries(Object.entries(used).filter(([k]) => k.startsWith(`${r.site}|`))),
        );
    });
  limits
    .command("set <site> <bucket> <n>")
    .description(
      "A daily cap for every account of the site, or with --account for one; 0 turns the bucket off",
    )
    .option("--account <name>", "the credential name (as `creds` lists it)")
    .action((name: string, bucket: string, n: string, o: { account?: string }) =>
      edit(name, (l) => {
        if (!o.account) return { ...l, caps: { ...l.caps, [bucket]: count(n) } };
        const accounts = l.accounts ?? {};
        return {
          ...l,
          accounts: { ...accounts, [o.account]: { ...accounts[o.account], [bucket]: count(n) } },
        };
      }),
    );
  limits
    .command("pace <site> <gapMs> [jitterMs]")
    .description(
      "The least gap between one account's calls to the site, plus up to jitterMs at random",
    )
    .action((name: string, gap: string, jitter: string | undefined) =>
      edit(name, (l) => ({
        ...l,
        pace: {
          ...l.pace,
          gapMs: count(gap),
          ...(jitter !== undefined ? { jitterMs: count(jitter) } : {}),
        },
      })),
    );
  limits
    .command("unset <site> [bucket]")
    .description("Back to the code's default: one bucket, the pace (--pace), or the whole site")
    .option("--account <name>", "the bucket of this account's own caps")
    .option("--pace", "the pace")
    .action((name: string, bucket: string | undefined, o: { account?: string; pace?: boolean }) =>
      edit(name, (l) => {
        if (o.pace) {
          const { pace: _, ...rest } = l;
          return rest;
        }
        if (!bucket) return {};
        const drop = (c: Record<string, number> = {}) => {
          const { [bucket]: _, ...rest } = c;
          return rest;
        };
        if (!o.account) return { ...l, caps: drop(l.caps) };
        return { ...l, accounts: { ...l.accounts, [o.account]: drop(l.accounts?.[o.account]) } };
      }),
    );
}

export function registerSiteCommands(program: Command, local: LocalBackend, box?: Ingress): void {
  registerLimitCommands(program, local);
  const site = program
    .command("site")
    .description("Services under their official API's shape: API with a token, browser without")
    .action(async () => {
      const sites = local().backend.sites;
      if (!sites) throw new Error("no site apis here");
      const rows = (await sites.list()).map((s) => {
        const left = s.setup.filter((x) => !x.done).map((x) => x.name);
        return [
          accent(s.site),
          s.refused?.length
            ? bad(`token refused since ${utcOf(s.refused[0]?.since ?? "")}`)
            : s.authed
              ? good("token ok")
              : warn("no token"),
          `${s.routes.length} routes`,
          left.length ? warn(`setup left: ${left.join(", ")}`) : dim("set up"),
        ];
      });
      for (const line of columns(rows)) console.log(line);
      console.log(dim("\nautobrowse site status <site>: its routes and setup"));
    });
  site
    .command("status <site>")
    .description("Every route and how it answers now; every setup step and what blocks it")
    .action(async (name: string) => {
      const sites = local().backend.sites;
      if (!sites) throw new Error("no site apis here");
      const s = await sites.status(name);
      console.log(
        `${bold(s.site)} ${dim(s.origin)}  ${s.refused?.length ? bad("token refused") : s.authed ? good("token ok") : warn("no token")}`,
      );
      for (const r of s.refused ?? []) console.log(bad(`  refused: ${refusedLine(r)}`));
      // `!` = irreversible; a route that cannot answer yet says what it lacks instead of what it does.
      const routes = s.routes.map((r) => [
        `  ${r.irreversible ? warn("!") : " "} ${r.method}`,
        r.path,
        dim(r.via),
        r.missing ? warn(r.missing) : r.summary,
      ]);
      for (const line of columns(routes)) console.log(line);
      if (!s.setup.length) return;
      console.log(`\n${bold("setup")}`);
      const steps = s.setup.map((st) => [
        `  ${st.name}`,
        st.done
          ? good("done")
          : st.blockedOn.length
            ? warn(`blocked on ${st.blockedOn.join(", ")}`)
            : st.unrecorded
              ? warn(`flow ${st.unrecorded} not recorded`)
              : "ready",
        dim(`→ ${st.makes.join(", ")}${st.input ? `  input ${JSON.stringify(st.input)}` : ""}`),
      ]);
      for (const line of columns(steps)) console.log(line);
    });
  site
    .command("check [site]")
    .description("Prove each site's token with one who-am-I call; every site by default")
    .option("--account <address>", "as that consented account")
    .action(async (name: string | undefined, o: { account?: string }) => {
      const sites = local().backend.sites;
      if (!sites) throw new Error("no site apis here");
      const rows = name ? [await sites.status(name)] : await sites.list();
      const checks = await Promise.all(rows.map((r) => checkSite(sites, r, o.account ?? null)));
      for (const line of columns(checks.map(checkRow))) console.log(line);
      // What is refused now, this check's finds included, with since when.
      const open = ((await sites.refused?.()) ?? []).filter((r) => !name || r.site === name);
      for (const r of open) console.log(bad(`refused: ${refusedLine(r)}`));
      if ((name && !checks[0]?.ok) || open.length) process.exitCode = 1;
    });
  site
    .command("route <site> <method> <path>")
    .description(
      "What one route takes: its fields, or with --template a body to fill in for `site call --body file.json`",
    )
    .option("--template", "print a request to fill in")
    .action(async (name: string, method: string, path: string, o: { template?: boolean }) => {
      const sites = local().backend.sites;
      if (!sites) throw new Error("no site apis here");
      const { inputLines, inputsOfJson, templateOf } = await import("../engine/inputs.js");
      const s = await sites.status(name);
      const r = s.routes.find((x) => x.method === method.toUpperCase() && x.path === path);
      if (!r)
        throw new Error(
          `no ${method.toUpperCase()} ${path} on ${name}; see \`site status ${name}\``,
        );
      if (o.template) return console.log(JSON.stringify(templateOf(r.request), null, 2));
      console.log(
        `${r.method} ${r.path}: ${r.summary}${r.irreversible ? "  (irreversible)" : ""}${r.spends ? "  (spends)" : ""}`,
      );
      console.log(`answers via ${r.via}${r.missing ? `: ${r.missing}` : ""}`);
      console.log("inputs:");
      for (const line of inputLines(inputsOfJson(r.request))) console.log(line);
    });
  site
    .command("call <site> <method> <path>")
    .description(
      "One call as the official API takes it; `--body` is inline JSON, a file, or - for stdin",
    )
    .option("--body <json|file>", "the request body (writes) or query (reads)")
    .option(
      "--account <address>",
      "as that consented account (its own token); the site's own by default",
    )
    .action(
      async (
        name: string,
        method: string,
        path: string,
        o: { body?: string; account?: string },
      ) => {
        const sites = local().backend.sites;
        if (!sites) throw new Error("no site apis here");
        const input = o.body ? ((await readJson(o.body)) as Record<string, unknown>) : {};
        const out = await sites.call(
          name,
          method.toUpperCase() as Method,
          path,
          input,
          o.account ?? null,
        );
        console.log(JSON.stringify(out, null, 2));
      },
    );
  site
    .command("setup <site> <step>")
    .description(
      "Make a key or token: a browser flow on the developer console, or an OAuth consent",
    )
    .option(
      "--account <address>",
      "consent as that account (a `<site>@<label>` credential with that username signs in); its token is kept under its own name",
    )
    .option(
      "--profile <name>",
      "force the browser profile it runs in: a second profile for the same account, when the first one's session is stuck",
    )
    .option(
      "--input <json|file>",
      "over the step's input, key by key (a token's name, scopes, expiry); `site status` shows what it takes",
    )
    .action(
      async (
        name: string,
        step: string,
        o: { account?: string; profile?: string; input?: string },
      ) => {
        const sites = local().backend.sites;
        if (!sites) throw new Error("no site apis here");
        const input = o.input ? ((await readJson(o.input)) as Record<string, unknown>) : undefined;
        const { made } = await sites.setup(name, step, o.account ?? null, o.profile ?? null, input);
        console.log(`kept ${made.join(", ")}`);
      },
    );
  site
    .command("caps [site]")
    .description("A day's capped reads: each bucket's use and who made each call (route, outcome)")
    .option("--day <yyyy-mm-dd>", "a past day (UTC); today by default")
    .option("--box", "the box's ledger, through Restate, instead of this machine's")
    .option("--rows", "every call, with its time and Restate invocation")
    .option("--json", "the report as JSON")
    .action(
      async (
        name: string | undefined,
        o: { day?: string; box?: boolean; rows?: boolean; json?: boolean },
      ) => {
        let r: CapsReport;
        if (o.box) {
          if (!box) throw new Error("no Restate ingress here");
          r = await box
            .sites()
            .caps({ ...(o.day ? { day: o.day } : {}), ...(name ? { site: name } : {}) });
        } else {
          const sites = local().backend.sites;
          if (!sites) throw new Error("no site apis here");
          r = sites.caps(o.day, name);
        }
        if (o.json) console.log(JSON.stringify(r, null, 2));
        else printCaps(r, Boolean(o.rows));
      },
    );
  site
    .command("renew")
    .description(
      "Prove each token, then make again every refused one and every one that lapses within 14 days, by the setup step and account that made it (wren's TokenRenewal runs this daily on the desk)",
    )
    .option("--dry", "only say what is due; no probes")
    .option("--names <names...>", "only these refused names, made again now")
    .action(async (o: { dry?: boolean; names?: string[] }) => {
      const sites = local().backend.sites;
      if (!sites?.renew) throw new Error("no site apis here");
      const r = await sites.renew({ dry: Boolean(o.dry), ...(o.names ? { names: o.names } : {}) });
      console.log(r.lines.join("\n") || "nothing refused or lapsing within 14 days");
      if (r.results.some((x) => !x.ok)) process.exitCode = 1;
    });
  site
    .command("revoke <site>")
    .description(
      "End the grant behind a site's token at the site (every token it covered dies, other holders' too) and queue their re-make: the only way our code revokes",
    )
    .option("--account <address>", "that consented account's grant; the policy's by default")
    .option(
      "--after <minutes>",
      "wait this long before the re-make (a consent screen filmed first)",
      (v) => Number.parseInt(v, 10),
      0,
    )
    .option("--here", "on this machine, re-made inline, instead of the desk through Restate")
    .action(async (name: string, o: { account?: string; after: number; here?: boolean }) => {
      if (o.here) {
        const sites = local().backend.sites;
        if (!sites?.revoke || !sites.renew) throw new Error("no revoke here");
        const { revoked } = await sites.revoke(name, o.account ?? null);
        console.log(`revoked ${revoked.join(", ")}`);
        if (o.after) await new Promise((ok) => setTimeout(ok, o.after * 60_000));
        const r = await sites.renew({ names: revoked });
        console.log(r.lines.join("\n"));
        if (r.results.some((x) => !x.ok)) process.exitCode = 1;
        return;
      }
      if (!box) throw new Error("no Restate ingress here; --here runs it on this machine");
      const out = await box
        .desk()
        .revoke({ site: name, ...(o.account ? { account: o.account } : {}), after: o.after });
      console.log(
        `revoked ${out.revoked.join(", ")}; re-make queued on the desk${out.after ? ` in ${out.after} min` : ""}`,
      );
    });
}
