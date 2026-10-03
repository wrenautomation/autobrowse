#!/usr/bin/env node
/**
 * `autobrowse`: start a run, answer its gates, pause and play, list runs,
 * log into a site once, record a chore. Every workflow the worker serves
 * gets `run <workflow> <key> --plan file.json`; `domain` has its own flags.
 */
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { cloudflare } from "../clients/cloudflare.js";
import { httpClient } from "../clients/http.js";
import type { GateName } from "../engine/effects.js";
import { cursorOf } from "../engine/rows.js";
import { summarize } from "../engine/run.js";
import { ownerKeys } from "../owner.js";
import { DEFAULT_TLDS, domainIdeas } from "../workflows/domain/ideas.js";
import { type PlanInput, parseInboxSpec } from "../workflows/domain/index.js";
import { MAIN_SITE } from "../workflows/redirect/index.js";
import { localBackend, proofsOf, workflowsOf } from "./backend.js";
import { registerAccessCommands } from "./cli-access.js";
import { registerAccountsCommands } from "./cli-accounts.js";
import { registerAuthCommands } from "./cli-auth.js";
import { registerAwsCommands } from "./cli-aws.js";
import { registerDesktopCommands } from "./cli-desktop.js";
import { registerDoCommands } from "./cli-do.js";
import { registerEnvCommands } from "./cli-env.js";
import { readJson } from "./cli-json.js";
import { registerLangfuseCommands } from "./cli-langfuse.js";
import { registerNeedsCommands } from "./cli-needs.js";
import { registerReachCommands } from "./cli-reach.js";
import { registerRecordCommands } from "./cli-record.js";
import { registerRunsCommands } from "./cli-runs.js";
import { registerShotsCommands } from "./cli-shots.js";
import { registerSiteCommands } from "./cli-site.js";
import { registerUnsubscribe } from "./cli-unsubscribe.js";
import { registerWalletCommands } from "./cli-wallet.js";
import {
  registerRepairsCommands,
  registerScreensCommands,
  registerWatchedCommands,
} from "./cli-watched.js";
import { ingress } from "./client.js";
import { fileDone } from "./needs.js";
import { needsContextFor } from "./owed.js";
import { awsFor, boot, ownerFromArgv } from "./owner.js";
import {
  credentialsFor,
  domainDepsFor,
  envStoreFor,
  identitiesFor,
  LOCAL_WORKFLOWS,
  WORKFLOWS,
} from "./services.js";

// `--owner` picks whose env, files and names load, so it is read before anything else.
const argvOwner = ownerFromArgv(process.argv);
if (argvOwner === "") {
  console.error("--owner needs a name");
  process.exit(2);
}
if (argvOwner) process.env.AUTOBROWSE_OWNER = argvOwner;
const { settings } = boot();
const api = ingress({
  url: settings.restateIngressUrl,
  authToken: settings.restateAuthToken ?? null,
  owner: settings.owner,
});

const local = localBackend(settings, api);

/**
 * A Restate call with a stopped worker behind it waits, silently, until the
 * box is back: say so after a while instead of looking hung. The call itself
 * is left to finish (Restate holds it; the box's idle stop is by design).
 */
async function patient<T>(call: PromiseLike<T>, afterMs = 10_000): Promise<T> {
  const note = setTimeout(
    () =>
      console.error(
        `still waiting after ${afterMs / 1000} s: Restate at ${settings.restateIngressUrl} has the call, but no worker is answering (a local one: pnpm worker; the box: deploy/scripts/box.sh status, box.sh start)`,
      ),
    afterMs,
  );
  try {
    return await call;
  } finally {
    clearTimeout(note);
  }
}

const program = new Command("autobrowse")
  .showHelpAfterError()
  .option(
    "--owner <name>",
    "whose accounts, files and workers (designs/2026-09-30-owner-keys.md); default AUTOBROWSE_OWNER, else wren",
  )
  .hook("preAction", () => {
    // The early read and commander's must agree: a value that only looked like the flag must not switch owners.
    const { owner } = program.opts<{ owner?: string }>();
    if (owner !== argvOwner)
      throw new Error(
        `--owner: read as ${argvOwner ?? "unset"} early, ${owner ?? "unset"} by the parser; pass it once, as its own flag`,
      );
  });

program
  .command("workflows [name]")
  .description(
    "What this worker can run; with a name, its steps and the inputs its plan takes (`!` = irreversible)",
  )
  .option(
    "--template",
    "print a plan to fill in and pass back as `run <name> <key> --plan file.json`",
  )
  .action(async (name: string | undefined, o: { template?: boolean }) => {
    const { proofLine } = await import("../workflows/proof.js");
    const { backend } = local();
    const [workflows, proofs] = await Promise.all([workflowsOf(backend), proofsOf(backend)]);
    if (name) {
      const { inputLines, inputsOf, templateOf } = await import("../engine/inputs.js");
      const w = workflows.find((x) => x.name === name);
      if (!w) throw new Error(`no workflow ${name}; see \`autobrowse workflows\``);
      if (o.template) return console.log(JSON.stringify(templateOf(w.plan), null, 2));
      console.log(`${w.name}: ${w.description}`);
      console.log(
        `steps: ${w.steps.map((s) => `${s.name}${s.irreversible ? "!" : ""}`).join(" → ")}`,
      );
      console.log("inputs:");
      for (const line of inputLines(inputsOf(w.plan))) console.log(line);
      return;
    }
    for (const w of workflows) {
      const proof = proofs[w.name];
      const note = proof ? proofLine(proof) : w.name in proofs ? "draft" : "hand-written";
      console.log(
        `${w.name.padEnd(16)} ${w.description}  [${w.steps.map((s) => s.name).join(" → ")}]  ${note}`,
      );
    }
  });

program
  .command("flows")
  .description(
    "Every deterministic browser leg on this worker: hand-written flows with the routes that call them, compiled workflows with their proof, walks (`!` = irreversible)",
  )
  .option("--site <site>", "one site's legs")
  .action(async (o: { site?: string }) => {
    const { BROWSER_FLOWS } = await import("../engine/browser-service.js");
    const { SITES } = await import("../sites/index.js");
    const { listWalks } = await import("../walks/spec.js");
    const { walksDirFor } = await import("./services.js");
    const { proofLine } = await import("../workflows/proof.js");
    const { backend } = local();
    const [workflows, proofs] = await Promise.all([workflowsOf(backend), proofsOf(backend)]);
    const site = o.site?.trim().toLowerCase();
    // Each leg's callers: the official-API routes whose browser leg it is.
    const callers = new Map<string, { route: string; irreversible: boolean }[]>();
    for (const s of SITES)
      for (const r of s.routes) {
        if (!r.browser) continue;
        const leg = "flow" in r.browser ? r.browser.flow : r.browser.workflow;
        const list = callers.get(leg) ?? [];
        list.push({
          route: `${r.method} ${s.site}${r.path}`,
          irreversible: Boolean(r.irreversible),
        });
        callers.set(leg, list);
      }
    const mark = (leg: string) => (callers.get(leg)?.some((c) => c.irreversible) ? "!" : " ");
    const via = (leg: string) => {
      const c = callers.get(leg) ?? [];
      return c.length ? c.map((x) => x.route).join(", ") : "no route (flow({name}) only)";
    };
    const flows = Object.keys(BROWSER_FLOWS)
      .filter((n) => !site || n.startsWith(`${site}/`))
      .sort();
    console.log(`hand-written flows (src/browser/flows): ${flows.length}`);
    for (const n of flows) console.log(`  ${mark(n)} ${n.padEnd(34)} ${via(n)}`);
    const compiled = workflows.filter(
      (w) => !site || w.name.startsWith(`${site}-`) || w.name.includes(`-${site}`),
    );
    console.log(`\ncompiled workflows (src/workflows): ${compiled.length}`);
    for (const w of compiled) {
      const proof = proofs[w.name];
      const note = proof
        ? proofLine(proof)
        : w.name in proofs
          ? "draft, never run"
          : "hand-written";
      const bang = w.steps.some((s) => s.irreversible) ? "!" : " ";
      console.log(
        `  ${bang} ${w.name.padEnd(34)} ${note}; steps ${w.steps.map((s) => `${s.name}${s.irreversible ? "!" : ""}`).join(" → ")}; ${via(w.name)}`,
      );
    }
    const walks = listWalks(walksDirFor(settings)).filter((w) => !site || w.site === site);
    console.log(`\nwalks (built from runs, ${walksDirFor(settings)}): ${walks.length}`);
    for (const w of walks)
      console.log(
        `  ${w.irreversible ? "!" : " "} ${`${w.site}/walk-${w.name}`.padEnd(34)} ${w.screens} screens from ${w.runs} runs; ${w.goal.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>").slice(0, 60)}`,
      );
  });

program
  .command("run <workflow> <key>")
  .description("Start a run from a plan (JSON); omit --plan to resume the stored one")
  .option("--plan <json|file>", "inline JSON, a file path, or - for stdin")
  .option("--dry-run", "plan only; stop before the first irreversible step")
  .action(async (workflow: string, key: string, o: { plan?: string; dryRun?: boolean }) => {
    let plan = o.plan ? ((await readJson(o.plan)) as Record<string, unknown>) : null;
    // The run may happen on the box: files the plan names on this machine go with it.
    if (plan && settings.shotsBucket) {
      const { shipPlanFiles, s3InputStore } = await import("../browser/run-files.js");
      const r = await shipPlanFiles(
        plan,
        s3InputStore(settings.shotsBucket, awsFor(settings)),
        ownerKeys(settings.owner).inputs,
      );
      plan = r.plan as Record<string, unknown>;
      for (const f of r.shipped) console.log(`shipped ${f} (the run reads it for a week)`);
    }
    await patient(api.run(workflow, key).run(plan ? { ...plan, dryRun: o.dryRun ?? false } : null));
    console.log(
      `${plan ? "started" : "resumed"} ${workflow}/${key}; watch: autobrowse status ${workflow} ${key}`,
    );
  });

program
  .command("try <workflow>")
  .description(
    "Run a workflow in this process, no Restate: real browser, in-memory journal. Gates answer approved unless --ask. The proof a compiled recording works.",
  )
  .option("--plan <json|file>", "inline JSON, a file path, or - for stdin; default {}")
  .option("--dry-run", "plan only; stop before the first irreversible step")
  .option("--ask", "stop at the first gate instead of approving it")
  .option("--headed", "show the browser")
  .option("--prove", "write the outcome as proof.json beside the compiled workflow")
  .action(
    async (
      name: string,
      o: { plan?: string; dryRun?: boolean; ask?: boolean; headed?: boolean; prove?: boolean },
    ) => {
      const { compiledDeps } = await import("../workflows/compiled.js");
      const { memoryEffects } = await import("../engine/memory.js");
      const { runFlow } = await import("../engine/run.js");
      const { backend, parts } = local({ headless: o.headed ? false : settings.browserHeadless });
      const workflow = (await workflowsOf(backend)).find((w) => w.name === name);
      if (!workflow) throw new Error(`unknown workflow ${name}; see: autobrowse workflows`);
      // The domain family's APIs are built here too: its browser legs then sign in from
      // this machine's profiles and IP. bootstrap still wants the worker.
      const handWritten = WORKFLOWS.includes(workflow);
      if (handWritten && !LOCAL_WORKFLOWS.includes(workflow))
        throw new Error(`${name} needs the worker's deps (APIs); run it with: autobrowse run`);
      const raw = o.plan ? ((await readJson(o.plan)) as Record<string, unknown>) : {};
      const plan = workflow.plan.parse({ ...raw, dryRun: o.dryRun ?? false });
      if (o.prove) {
        // A proof is its own kind of run: gates declined, nothing bought, the outcome kept beside the flow.
        if (!backend.prove) throw new Error("no browser here to prove with");
        const proof = await backend.prove(name, raw);
        for (const s of proof.steps) console.log(`${s.name.padEnd(28)} ${s.status}  ${s.detail}`);
        console.log(proof.status);
        if (proof.status !== "done") process.exitCode = 1;
        return;
      }
      const out = await runFlow(
        memoryEffects({ sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }).fx,
        workflow as never,
        (handWritten
          ? domainDepsFor(settings, parts.browser)
          : compiledDeps(parts.browser)) as never,
        plan,
        () =>
          o.ask ? null : { approved: true, note: "autobrowse try", at: new Date().toISOString() },
      );
      for (const [step, r] of Object.entries(out.results))
        if (r) console.log(`${step.padEnd(28)} ${r.status}  ${r.detail}`);
      console.log(out.status);
      if (out.status !== "done") process.exitCode = 1;
    },
  );

program
  .command("domain <domain>")
  .description("Provision a domain end to end: buy, DNS, Workspace, inboxes, warmup, roster, loops")
  .requiredOption(
    "--inbox <local:Given:Family...>",
    "inbox as local:Given:Family (repeatable)",
    (v: string, all: string[]) => [...all, v],
    [],
  )
  .option("--niches <list>", "comma list, or all", "all")
  .option("--signature-file <path>", "HTML signature for Gmail send-as")
  .option("--no-buy", "fail instead of buying when the domain is free")
  .option("--no-warmup", "skip warmup enrollment")
  .option("--warmup-like <email>", "copy this Instantly inbox's warmup settings onto each new one")
  .option("--photo-url <url>", "each inbox's profile picture (a GIF stays animated)")
  .option("--no-handoff", "do not touch wren's roster or loops")
  .option(
    "--redirect [url]",
    "then 301 the domain's site to the main one (runs sender-domain = domain + redirect)",
  )
  .option("--dry-run", "plan only; stop before the first irreversible step")
  .action(
    async (
      domain: string,
      o: {
        inbox: string[];
        redirect?: string | true;
        niches: string;
        signatureFile?: string;
        buy: boolean;
        warmup: boolean;
        warmupLike?: string;
        photoUrl?: string;
        handoff: boolean;
        dryRun?: boolean;
      },
    ) => {
      const plan: PlanInput = {
        domain,
        inboxes: o.inbox.map(parseInboxSpec),
        niches: o.niches === "all" ? "all" : o.niches.split(",").map((s) => s.trim()),
        ...(o.signatureFile ? { signatureHtml: await readFile(o.signatureFile, "utf8") } : {}),
        buy: o.buy,
        warmup: o.warmup,
        ...(o.warmupLike ? { warmupLike: o.warmupLike } : {}),
        ...(o.photoUrl ? { photoUrl: o.photoUrl } : {}),
        handoff: o.handoff,
        dryRun: o.dryRun ?? false,
      };
      const flow = o.redirect ? "sender-domain" : "domain";
      const redirect = typeof o.redirect === "string" ? { redirectTo: o.redirect } : {};
      await patient(api.run(flow, domain).run({ ...plan, ...redirect }));
      console.log(`started ${flow}/${domain}; watch: autobrowse status ${flow} ${domain}`);
    },
  );

program
  .command("redirect <domain>")
  .description("301 every URL on a domain (already on Cloudflare) to the main site")
  .option("--to <url>", "where it lands", MAIN_SITE)
  .action(async (domain: string, o: { to: string }) => {
    await patient(api.run("redirect", domain).run({ domain, redirectTo: o.to }));
    console.log(`started redirect/${domain}; watch: autobrowse status redirect ${domain}`);
  });

program
  .command("domains <words...>")
  .description(
    "Sending-domain ideas: the brand's spellings × extensions, with Cloudflare's price; buy one with `domain <name>`",
  )
  .option("--tld <list>", "extensions, comma list", DEFAULT_TLDS.join(","))
  .option("--max <usd>", "hide free ones that cost more than this a year")
  .option("--all", "also list the ones someone else holds or Cloudflare cannot sell")
  .action(async (words: string[], o: { tld: string; max?: string; all?: boolean }) => {
    if (!settings.cloudflareApiToken || !settings.cloudflareAccountId)
      throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID: autobrowse env pull");
    const cf = cloudflare({
      apiToken: settings.cloudflareApiToken,
      accountId: settings.cloudflareAccountId,
      http: httpClient(),
    });
    const max = o.max ? Number(o.max) : Number.POSITIVE_INFINITY;
    const quotes = await cf.check(domainIdeas(words, o.tld.split(",")));
    for (const q of quotes) {
      if (q.registrable) {
        if (Number(q.price) <= max)
          console.log(`free   $${q.price?.padEnd(6)} renews $${q.renewal?.padEnd(6)} ${q.name}`);
      } else if (q.reason === "domain_unavailable" && (await cf.registered(q.name)))
        console.log(`ours                               ${q.name}`);
      else if (o.all) console.log(`${(q.reason ?? "no").padEnd(34)} ${q.name}`);
    }
  });

program
  .command("inbox-name <address> <first> <last>")
  .description(
    "The name mail shows beside a Workspace inbox (users cannot change it themselves): set through the admin API",
  )
  .action(async (address: string, first: string, last: string) => {
    const { googleAdminFor } = await import("./services.js");
    const { SCOPES } = await import("../google-auth.js");
    // Only the user scope: a name needs nothing more.
    await googleAdminFor(settings, undefined, [SCOPES.directoryUser]).setName(
      address.toLowerCase(),
      first,
      last,
    );
    console.log(`${address}: name is now ${first} ${last} (mail shows it within minutes)`);
  });

program
  .command("inbox-photo <address> <file>")
  .description(
    "A Workspace inbox's picture through the admin API, no sign-in (PNG or JPEG, still); `profile-photo` keeps a GIF animated but signs in",
  )
  .action(async (address: string, file: string) => {
    const { readFile } = await import("node:fs/promises");
    const { googleAdminFor } = await import("./services.js");
    const { SCOPES } = await import("../google-auth.js");
    const mimeType = /\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png";
    await googleAdminFor(settings, undefined, [SCOPES.directoryUser]).setPhoto(
      address.toLowerCase(),
      await readFile(file),
      mimeType,
    );
    console.log(`${address}: picture set (Gmail shows it within a day)`);
  });

program
  .command("warmup-match <like> [emails...]")
  .description(
    "Instantly: copy one inbox's warmup and sending settings onto others (every other inbox when none named)",
  )
  .option("--dry-run", "say what differs, change nothing")
  .action(async (like: string, emails: string[], o: { dryRun?: boolean }) => {
    const { instantlyFor } = await import("./services.js");
    const ins = await instantlyFor(settings);
    if (!ins) throw new Error("no INSTANTLY_API_KEY in the environment or the env store");
    const want = await ins.settings(like);
    if (!want.warmup) throw new Error(`Instantly has no warmup settings on ${like}`);
    const targets =
      emails.length > 0
        ? emails
        : (await ins.accounts()).map((a) => a.email).filter((e) => e !== like);
    for (const email of targets) {
      const have = await ins.settings(email);
      const differs = Object.keys(want).filter(
        (k) =>
          JSON.stringify(have[k as keyof typeof have]) !==
          JSON.stringify(want[k as keyof typeof want]),
      );
      if (differs.length === 0) {
        console.log(`${email}: already alike`);
        continue;
      }
      if (!o.dryRun) await ins.setSettings(email, want);
      console.log(`${email}: ${o.dryRun ? "differs in" : "set"} ${differs.join(", ")}`);
    }
  });

for (const verb of ["approve", "reject"] as const) {
  program
    .command(`${verb} <workflow> <key> <gate>`)
    .option("--note <text>")
    .action(async (workflow: string, key: string, gate: GateName, o: { note?: string }) => {
      const g = await patient(
        api.run(workflow, key)[verb]({ name: gate, ...(o.note ? { note: o.note } : {}) }),
      );
      console.log(`${verb}d ${g.name} at ${g.step} (opened ${g.openedAt})`);
    });
}

for (const verb of ["pause", "play", "reset"] as const) {
  program.command(`${verb} <workflow> <key>`).action(async (workflow: string, key: string) => {
    await patient(api.run(workflow, key)[verb]());
    console.log(`${verb} ${workflow}/${key}`);
  });
}

program.command("status <workflow> <key>").action(async (workflow: string, key: string) => {
  const s = await patient(api.run(workflow, key).status());
  if (s.paused) console.log("PAUSED");
  if (s.gate) {
    console.log(`GATE ${s.gate.name} at ${s.gate.step} since ${s.gate.openedAt}: ${s.gate.prompt}`);
    if (s.gate.screenshot) console.log(`  screenshot ${s.gate.screenshot}`);
    if (s.gate.trace) console.log(`  trace      npx playwright show-trace ${s.gate.trace}`);
  }
  console.log(s.outcome ? summarize(s.outcome) : "no run yet");
});

program
  .command("runs")
  .description("Runs the registry knows, newest first")
  .option("--limit <n>", "how many", "100")
  .option(
    "--before <cursor>",
    "the next page: the cursor the last line printed (a bare updatedAt works too)",
  )
  .action(async (opts: { limit: string; before?: string }) => {
    const q = { limit: Number(opts.limit) || 100, ...(opts.before ? { before: opts.before } : {}) };
    const rows = await patient(api.registry().list(q));
    for (const r of rows)
      console.log(
        `${r.status.padEnd(9)} ${`${r.workflow}/${r.key}`.padEnd(40)} ${r.gate ? `gate:${r.gate}` : (r.lastStep ?? "")}  ${r.updatedAt}`,
      );
    const last = rows.at(-1);
    if (last && rows.length === q.limit) console.log(`next: --before ${cursorOf(last)}`);
  });

registerRecordCommands(program, settings, local);
registerSiteCommands(program, local, api);
registerUnsubscribe(program, local);
registerAwsCommands(program, local, settings);
registerLangfuseCommands(program, () => envStoreFor(settings));
registerReachCommands(program, () => envStoreFor(settings), local);
registerShotsCommands(program, settings);
registerWatchedCommands(program, settings);
registerRunsCommands(program, settings, local);
registerRepairsCommands(program, settings);
registerScreensCommands(program, settings);
program
  .command("fingerprint [profile]")
  .description(
    "How a browser looks to X, LinkedIn and Cloudflare: its IP's network and time zone, its page, and what gives it away. Runs in the profile, through its proxy",
  )
  .option("--headed", "show the browser")
  .option("--box", "run it on the worker behind Restate (the box: deploy/scripts/box.sh start)")
  .option("--json", "the whole reading as JSON")
  .action(
    async (profile: string | undefined, o: { headed?: boolean; box?: boolean; json?: boolean }) => {
      const { fingerprint } = await import("../browser/flows/fingerprint.js");
      const flow = profile ? { ...fingerprint, site: profile } : fingerprint;
      const got = o.box
        ? await patient(
            api
              .browser()
              .flow({ name: "fingerprint/check", input: {}, ...(profile ? { profile } : {}) }),
          )
        : await local({ headless: o.headed ? false : settings.browserHeadless }).parts.browser.run(
            flow,
            {},
          );
      const f = got as import("../browser/flows/fingerprint.js").Fingerprint;
      if (o.json) return console.log(JSON.stringify(f, null, 2));
      const ip = f.ip;
      console.log(
        `ip       ${ip ? `${ip.ip}  ${ip.org ?? "?"}  ${[ip.region, ip.country].filter(Boolean).join(", ")}  ${ip.timezone ?? ""}` : "unknown"}`,
      );
      const p = f.page;
      console.log(`browser  ${p.userAgent}`);
      console.log(
        `         ${p.timezone} · ${p.languages.join(",")} · ${p.cores} cores · ${p.screen.width}x${p.screen.height} · h264 ${p.h264 ? "yes" : "no"} · plugins ${p.plugins}`,
      );
      console.log(`webgl    ${p.webgl.renderer ?? "none"}`);
      console.log(`webrtc   ${p.webrtc.join(", ") || "no public IP"}`);
      console.log(f.tells.length ? `tells    ${f.tells.join("\n         ")}` : "tells    none");
      if (f.tells.length) process.exitCode = 1;
    },
  );

program
  .command("reap")
  .description(
    "Stop browsers whose owner died (they hold their profile); a live owner's browser is never touched",
  )
  .option("--dry", "name them only")
  .action(async (o: { dry?: boolean }) => {
    const { reapOrphans, reapTempDirs } = await import("../browser/reap.js");
    const { expandHome } = await import("../google-auth.js");
    const gone = await reapOrphans(expandHome(settings.profilesDir), o.dry ? { dry: true } : {});
    if (!gone.length) console.log("no orphaned browsers");
    if (!o.dry) console.log(`${await reapTempDirs()} stale temp folders removed`);
    for (const x of gone)
      console.log(`${o.dry ? "orphan" : "stopped"} ${x.profile} (pid ${x.pid})`);
  });
registerDoCommands(program, local);
registerAuthCommands(program, settings);
registerNeedsCommands(program, () => ({
  context: needsContextFor(settings),
  done: fileDone(settings.needsDoneFile),
  credentials: () => credentialsFor(settings),
  sites: () => local().backend.sites ?? null,
}));
registerAccountsCommands(program, () => ({
  identities: identitiesFor(settings),
  credentials: credentialsFor(settings, { armed: false }),
  env: (n) => process.env[n],
  envNames: () => Object.keys(process.env),
  workspaceDomain: settings.googleWorkspaceDomain?.toLowerCase() ?? null,
  push: (text) => envStoreFor(settings).put("AUTOBROWSE_ACCOUNTS", text),
}));
registerEnvCommands(program, settings, { store: () => envStoreFor(settings) });
registerDesktopCommands(program, tmpdir());
registerWalletCommands(program, settings);
registerAccessCommands(program, settings);

program.parseAsync().catch((err: unknown) => {
  // Name the command that failed, so a bare "exit code 1" always says why.
  const command = process.argv
    .slice(2)
    .filter((a) => !a.startsWith("-"))
    .slice(0, 2)
    .join(" ");
  const why = err instanceof Error ? err.message : String(err);
  console.error(`autobrowse ${command} failed: ${why}`);
  if (process.env.AUTOBROWSE_DEBUG && err instanceof Error) console.error(err.stack);
  else console.error("(rerun with AUTOBROWSE_DEBUG=1 for the stack)");
  process.exitCode = 1;
});
