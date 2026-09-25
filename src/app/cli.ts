#!/usr/bin/env tsx
/**
 * `autobrowse`: start a run, answer its gates, pause and play, list runs,
 * log into a site once, record a chore. Every workflow the worker serves
 * gets `run <workflow> <key> --plan file.json`; `domain` has its own flags.
 */
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Command } from "commander";
import type { GateName } from "../engine/effects.js";
import { cursorOf } from "../engine/rows.js";
import { summarize } from "../engine/run.js";
import { type PlanInput, parseInboxSpec } from "../workflows/domain/index.js";
import { localBackend, proofsOf, workflowsOf } from "./backend.js";
import { registerAccountsCommands } from "./cli-accounts.js";
import { registerAuthCommands } from "./cli-auth.js";
import { registerAwsCommands } from "./cli-aws.js";
import { registerDesktopCommands } from "./cli-desktop.js";
import { registerDoCommands } from "./cli-do.js";
import { registerEnvCommands } from "./cli-env.js";
import { readJson } from "./cli-json.js";
import { registerLangfuseCommands } from "./cli-langfuse.js";
import { registerNeedsCommands } from "./cli-needs.js";
import { registerRecordCommands } from "./cli-record.js";
import { registerShotsCommands } from "./cli-shots.js";
import { registerSiteCommands } from "./cli-site.js";
import { registerUnsubscribe } from "./cli-unsubscribe.js";
import { registerWalletCommands } from "./cli-wallet.js";
import { ingress } from "./client.js";
import { loadEnvFile, loadSettings } from "./config.js";
import { fileDone } from "./needs.js";
import { DONE_FILE, needsContextFor } from "./owed.js";
import { credentialsFor, envStoreFor, identitiesFor, phoneFor, WORKFLOWS } from "./services.js";

loadEnvFile();
const settings = loadSettings();
const api = ingress({
  url: settings.restateIngressUrl,
  authToken: settings.restateAuthToken ?? null,
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

const program = new Command("autobrowse").showHelpAfterError();

program
  .command("workflows")
  .description("What this worker can run")
  .action(async () => {
    const { proofLine } = await import("../workflows/proof.js");
    const { backend } = local();
    const [workflows, proofs] = await Promise.all([workflowsOf(backend), proofsOf(backend)]);
    for (const w of workflows) {
      const proof = proofs[w.name];
      const note = proof ? proofLine(proof) : w.name in proofs ? "draft" : "hand-written";
      console.log(
        `${w.name.padEnd(16)} ${w.description}  [${w.steps.map((s) => s.name).join(" → ")}]  ${note}`,
      );
    }
  });

program
  .command("run <workflow> <key>")
  .description("Start a run from a plan (JSON); omit --plan to resume the stored one")
  .option("--plan <json|file>", "inline JSON, a file path, or - for stdin")
  .option("--dry-run", "plan only; stop before the first irreversible step")
  .action(async (workflow: string, key: string, o: { plan?: string; dryRun?: boolean }) => {
    const plan = o.plan ? ((await readJson(o.plan)) as Record<string, unknown>) : null;
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
      if (WORKFLOWS.includes(workflow))
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
        memoryEffects().fx,
        workflow as never,
        compiledDeps(parts.browser) as never,
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
  .option("--no-handoff", "do not touch wren's roster or loops")
  .option("--dry-run", "plan only; stop before the first irreversible step")
  .action(
    async (
      domain: string,
      o: {
        inbox: string[];
        niches: string;
        signatureFile?: string;
        buy: boolean;
        warmup: boolean;
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
        handoff: o.handoff,
        dryRun: o.dryRun ?? false,
      };
      await patient(api.run("domain", domain).run(plan));
      console.log(`started domain/${domain}; watch: autobrowse status domain ${domain}`);
    },
  );

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
registerSiteCommands(program, local);
registerUnsubscribe(program, local);
registerAwsCommands(program, local);
registerLangfuseCommands(program, () => envStoreFor(settings));
registerShotsCommands(program, settings);
program
  .command("reap")
  .description(
    "Stop browsers whose owner died (they hold their profile); a live owner's browser is never touched",
  )
  .option("--dry", "name them only")
  .action(async (o: { dry?: boolean }) => {
    const { reapOrphans } = await import("../browser/reap.js");
    const { expandHome } = await import("../google-auth.js");
    const gone = await reapOrphans(expandHome(settings.profilesDir), o.dry ? { dry: true } : {});
    if (!gone.length) console.log("no orphaned browsers");
    for (const x of gone)
      console.log(`${o.dry ? "orphan" : "stopped"} ${x.profile} (pid ${x.pid})`);
  });
registerDoCommands(program, local);
registerAuthCommands(program, settings);
registerNeedsCommands(program, () => ({
  context: needsContextFor(settings),
  done: fileDone(DONE_FILE),
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
