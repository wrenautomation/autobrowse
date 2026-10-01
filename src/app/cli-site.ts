/**
 * `autobrowse site`: the site APIs from the terminal, on the same Backend
 * the HTTP face serves. `site` lists them, `site <name>` says what answers
 * and what setup is left, `site <name> call` is one official call, `site
 * <name> setup <step>` makes a key or token, `site check` proves each token live,
 * `site caps` says who spent a day's capped reads.
 */
import type { Command } from "commander";
import type { CapsReport } from "../sites/facade.js";
import { checkSite, type Method } from "../sites/index.js";
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
    console.log(`  ${site} ${maskAddress(account ?? "")} ${bucket}: ${n}`);
  }
  const groups = new Map<string, number>();
  for (const c of r.calls) {
    const k = `${c.caller ?? "(unnamed)"}  ${c.site} ${maskAddress(c.account)}  ${c.route}  ${c.outcome}${c.bucket ? ` ${c.bucket}` : ""}`;
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

export function registerSiteCommands(program: Command, local: LocalBackend, box?: Ingress): void {
  const site = program
    .command("site")
    .description("Services under their official API's shape: API with a token, browser without")
    .action(async () => {
      const sites = local().backend.sites;
      if (!sites) throw new Error("no site apis here");
      for (const s of await sites.list()) {
        const left = s.setup.filter((x) => !x.done).map((x) => x.name);
        console.log(
          `${s.site.padEnd(10)} ${s.authed ? "token ok" : "no token"}  routes: ${s.routes.length}  setup left: ${left.join(", ") || "none"}`,
        );
      }
    });
  site
    .command("status <site>")
    .description("Every route and how it answers now; every setup step and what blocks it")
    .action(async (name: string) => {
      const sites = local().backend.sites;
      if (!sites) throw new Error("no site apis here");
      const s = await sites.status(name);
      console.log(`${s.site} → ${s.origin}  ${s.authed ? "token ok" : "no token"}`);
      for (const r of s.routes)
        console.log(
          `  ${r.method.padEnd(6)} ${r.path.padEnd(40)} ${r.via.padEnd(7)} ${r.irreversible ? "!" : " "} ${r.missing ?? r.summary}`,
        );
      for (const st of s.setup)
        console.log(
          `  setup ${st.name.padEnd(14)} ${st.done ? "done" : st.blockedOn.length ? `blocked on ${st.blockedOn.join(", ")}` : st.unrecorded ? `flow ${st.unrecorded} not recorded` : "ready"}  → ${st.makes.join(", ")}${st.input ? `  input ${JSON.stringify(st.input)}` : ""}`,
        );
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
      for (const c of checks) console.log(`${c.site.padEnd(10)} ${c.ok ? `ok ${c.ms}ms` : c.why}`);
      if (name && !checks[0]?.ok) process.exitCode = 1;
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
      "Make again every kept token that lapses within 14 days, by the setup step and account that made it (the box runs this daily)",
    )
    .option("--dry", "only say what is due")
    .action(async (o: { dry?: boolean }) => {
      const sites = local().backend.sites;
      if (!sites?.renew) throw new Error("no site apis here");
      const r = await sites.renew({ dry: Boolean(o.dry) });
      console.log(r.lines.join("\n") || "nothing lapses within 14 days");
      if (r.results.some((x) => !x.ok)) process.exitCode = 1;
    });
}
