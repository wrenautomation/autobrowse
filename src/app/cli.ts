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
import { accent, bad, bold, columns, dim, good, warn } from "../style.js";
import { DEFAULT_TLDS, domainIdeas } from "../workflows/domain/ideas.js";
import { type PlanInput, parseInboxSpec } from "../workflows/domain/index.js";
import { MAIN_SITE } from "../workflows/redirect/index.js";
import { localBackend, proofsOf, spentKeysFor, workflowsOf } from "./backend.js";
import { registerAccessCommands } from "./cli-access.js";
import { registerAccountsCommands } from "./cli-accounts.js";
import { registerAuthCommands } from "./cli-auth.js";
import { registerAwsCommands } from "./cli-aws.js";
import { registerDesktopCommands } from "./cli-desktop.js";
import { registerDoCommands } from "./cli-do.js";
import { registerEnvCommands } from "./cli-env.js";
import { readJson } from "./cli-json.js";
import { registerLangfuseCommands } from "./cli-langfuse.js";
import { registerModsCommands } from "./cli-mods.js";
import { registerNeedsCommands } from "./cli-needs.js";
import { registerReachCommands } from "./cli-reach.js";
import { registerRecordCommands } from "./cli-record.js";
import { registerRunsCommands } from "./cli-runs.js";
import { registerShotsCommands } from "./cli-shots.js";
import { registerSiteCommands } from "./cli-site.js";
import { registerTeachCommand } from "./cli-teach.js";
import { registerUnsubscribe } from "./cli-unsubscribe.js";
import { registerWalletCommands } from "./cli-wallet.js";
import {
  registerRepairsCommands,
  registerScreensCommands,
  registerWatchedCommands,
} from "./cli-watched.js";
import { ingress } from "./client.js";
import { tidyHelp } from "./help.js";
import { fileDone } from "./needs.js";
import { needsContextFor } from "./owed.js";
import { awsFor, boot, ownerFromArgv } from "./owner.js";
import {
  credentialsFor,
  domainDepsFor,
  envStoreFor,
  identitiesFor,
  inboxActivityDepsFor,
  inboxFleetDepsFor,
  LOCAL_WORKFLOWS,
  loadDataLogins,
  sinkFor,
  WORKFLOWS,
  workspaceInboxDepsFor,
} from "./services.js";

// `--owner` picks whose env, files and names load, so it is read before anything else.
const argvOwner = ownerFromArgv(process.argv);
if (argvOwner === "") {
  console.error("--owner needs a name");
  process.exit(2);
}
if (argvOwner) process.env.AUTOBROWSE_OWNER = argvOwner;
const { settings } = boot();
loadDataLogins(settings);
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
        `still waiting after ${afterMs / 1000} s: Restate at ${settings.restateIngressUrl} has the call, but no worker is answering (start one: pnpm worker)`,
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
    "whose accounts, files and workers; default AUTOBROWSE_OWNER, else wren",
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
    const { backend } = local();
    const [workflows, proofs] = await Promise.all([workflowsOf(backend), proofsOf(backend)]);
    if (name) {
      const { inputLines, inputsOf, templateOf } = await import("../engine/inputs.js");
      const w = workflows.find((x) => x.name === name);
      if (!w) throw new Error(`no workflow ${name}; see \`autobrowse workflows\``);
      if (o.template) return console.log(JSON.stringify(templateOf(w.plan), null, 2));
      console.log(`${bold(w.name)}  ${w.description}`);
      console.log(
        `${bold("steps")}   ${w.steps.map((s) => (s.irreversible ? warn(`${s.name}!`) : s.name)).join(dim(" → "))}`,
      );
      console.log(bold("inputs"));
      for (const line of inputLines(inputsOf(w.plan))) console.log(line);
      return;
    }
    // One line each: name, how far it is proven, what it does. Steps and inputs: `workflows <name>`.
    const state = (name: string) => {
      const proof = proofs[name];
      if (proof)
        return proof.status === "done"
          ? good(`proven ${proof.at.slice(0, 10)}`)
          : bad(`proof ${proof.status}`);
      return name in proofs ? warn("draft") : "hand-written";
    };
    for (const line of columns(
      workflows.map((w) => [accent(w.name), state(w.name), w.description]),
    ))
      console.log(line);
    console.log(dim("\nautobrowse workflows <name>: its steps and inputs"));
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
      // No route: only `flow({name})` runs it. Many: the first two and a count.
      if (!c.length) return "-";
      const shown = c
        .slice(0, 2)
        .map((x) => x.route)
        .join(", ");
      return c.length > 2 ? `${shown} +${c.length - 2} more` : shown;
    };
    const flows = Object.keys(BROWSER_FLOWS)
      .filter((n) => !site || n.startsWith(`${site}/`))
      .sort();
    const bang = (irreversible: boolean) => (irreversible ? warn("!") : " ");
    const section = (title: string, n: number) => console.log(`${bold(title)} ${dim(`(${n})`)}`);
    section("hand-written flows", flows.length);
    for (const line of columns(flows.map((n) => [` ${bang(mark(n) === "!")} ${n}`, dim(via(n))])))
      console.log(line);
    const compiled = workflows.filter(
      (w) => !site || w.name.startsWith(`${site}-`) || w.name.includes(`-${site}`),
    );
    const { proofLine } = await import("../workflows/proof.js");
    const proofOf = (name: string) => {
      const proof = proofs[name];
      if (proof) return proof.status === "done" ? good(proofLine(proof)) : bad(proofLine(proof));
      return name in proofs ? warn("draft, never run") : "hand-written";
    };
    console.log("");
    section("compiled workflows", compiled.length);
    for (const w of compiled) {
      console.log(` ${bang(w.steps.some((s) => s.irreversible))} ${w.name}  ${proofOf(w.name)}`);
      console.log(
        dim(
          `     ${w.steps.map((s) => `${s.name}${s.irreversible ? "!" : ""}`).join(" → ")}${via(w.name) === "-" ? "" : `; ${via(w.name)}`}`,
        ),
      );
    }
    const walks = listWalks(walksDirFor(settings)).filter((w) => !site || w.site === site);
    console.log("");
    section("walks, built from runs", walks.length);
    for (const line of columns(
      walks.map((w) => [
        ` ${bang(w.irreversible)} ${w.site}/walk-${w.name}`,
        `${w.screens} screens from ${w.runs} runs`,
        dim(
          `${w.goal.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>").slice(0, 60)}${w.mod ? `  (mod ${w.mod})` : ""}`,
        ),
      ]),
    ))
      console.log(line);
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
        (workflow.name === "inbox-activity"
          ? inboxActivityDepsFor(settings, parts.browser)
          : workflow.name === "inbox-fleet"
            ? inboxFleetDepsFor(settings)
            : workflow.name === "workspace-inbox"
              ? workspaceInboxDepsFor(settings, parts.browser, parts.sites, sinkFor(settings))
              : handWritten
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
  .command("inbox <address> <first> <last>")
  .description(
    "One Workspace inbox, ready (workflow workspace-inbox): user, password + authenticator stored, signature, photo, Gmail consent, accounts row",
  )
  .option("--consent <sites>", "sites to keep a consent token for, comma list", "gmail")
  .option("--for <purposes>", "its purposes in the accounts list, comma list", "sends")
  .option("--signature-file <path>", "HTML signature for Gmail send-as")
  .option("--photo-url <url>", "its profile picture (a GIF stays animated)")
  .option("--warmup", "enrol it in Instantly warmup")
  .option("--warmup-like <email>", "copy this Instantly inbox's warmup settings onto it")
  .option("--handoff", "put it on wren's roster and start its loops (it starts sending)")
  .option("--niches <list>", "comma list, or all (with --handoff)", "all")
  .option("--activity", "subscribe it to free newsletters and open their confirm links")
  .option("--dry-run", "plan only; stop before the first irreversible step")
  .action(
    async (
      address: string,
      first: string,
      last: string,
      o: {
        consent: string;
        for: string;
        signatureFile?: string;
        photoUrl?: string;
        warmup?: boolean;
        warmupLike?: string;
        handoff?: boolean;
        niches: string;
        activity?: boolean;
        dryRun?: boolean;
      },
    ) => {
      const list = (v: string) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      const key = address.toLowerCase();
      await patient(
        api.run("workspace-inbox", key).run({
          address: key,
          givenName: first,
          familyName: last,
          consents: list(o.consent),
          purposes: list(o.for),
          ...(o.signatureFile ? { signatureHtml: await readFile(o.signatureFile, "utf8") } : {}),
          ...(o.photoUrl ? { photoUrl: o.photoUrl } : {}),
          warmup: o.warmup ?? false,
          ...(o.warmupLike ? { warmupLike: o.warmupLike } : {}),
          handoff: o.handoff ?? false,
          niches: o.niches === "all" ? "all" : list(o.niches),
          activity: o.activity ?? false,
          dryRun: o.dryRun ?? false,
        }),
      );
      console.log(
        `started workspace-inbox/${key}; watch: autobrowse status workspace-inbox ${key}`,
      );
    },
  );

program
  .command("domains <words...>")
  .description(
    "Sending-domain ideas: the brand's spellings × extensions, with Cloudflare's price; buy one with `domain <name>`",
  )
  .option("--tld <list>", "extensions, comma list", DEFAULT_TLDS.join(","))
  .option("--max <usd>", "hide free ones that cost more than this a year")
  .option("--all", "also list the ones someone else holds or Cloudflare cannot sell")
  .option("--digits", "also one letter swapped for a look-alike digit (wrenautomati0n)")
  .action(
    async (words: string[], o: { tld: string; max?: string; all?: boolean; digits?: boolean }) => {
      if (!settings.cloudflareApiToken || !settings.cloudflareAccountId)
        throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID: autobrowse env pull");
      const cf = cloudflare({
        apiToken: settings.cloudflareApiToken,
        accountId: settings.cloudflareAccountId,
        http: httpClient(),
      });
      const max = o.max ? Number(o.max) : Number.POSITIVE_INFINITY;
      const quotes = await cf.check(
        domainIdeas(words, o.tld.split(","), { digits: o.digits === true }),
      );
      for (const q of quotes) {
        if (q.registrable) {
          if (Number(q.price) <= max)
            console.log(`free   $${q.price?.padEnd(6)} renews $${q.renewal?.padEnd(6)} ${q.name}`);
        } else if (q.reason === "domain_unavailable" && (await cf.registered(q.name)))
          console.log(`ours                               ${q.name}`);
        else if (o.all) console.log(`${(q.reason ?? "no").padEnd(34)} ${q.name}`);
      }
    },
  );

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
    const paint = (st: string) =>
      (st === "done"
        ? good
        : st === "failed" || st === "rejected"
          ? bad
          : st === "running"
            ? accent
            : warn)(st);
    for (const line of columns(
      rows.map((r) => [
        paint(r.status),
        `${r.workflow}/${r.key}`,
        r.gate ? warn(`gate ${r.gate}`) : (r.lastStep ?? ""),
        dim(r.updatedAt),
      ]),
    ))
      console.log(line);
    const last = rows.at(-1);
    if (last && rows.length === q.limit) console.log(`next: --before ${cursorOf(last)}`);
  });

registerRecordCommands(program, settings, local);
registerSiteCommands(program, local, api);
registerUnsubscribe(program, local);
registerAwsCommands(program, local, settings);
registerLangfuseCommands(program, () => envStoreFor(settings));
registerReachCommands(program, () => envStoreFor(settings), local, spentKeysFor(settings));
registerShotsCommands(program, settings);
registerWatchedCommands(program, settings);
registerModsCommands(program, settings);
registerRunsCommands(program, settings, local);
registerTeachCommand(program, settings);
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

tidyHelp(program);
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
