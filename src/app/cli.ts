#!/usr/bin/env tsx
/**
 * `autobrowse`: start a run, answer its gates, pause and play, list runs,
 * log into a site once, record a chore. Every workflow the worker serves
 * gets `run <workflow> <key> --plan file.json`; `domain` has its own flags.
 */
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import type { GateName } from "../engine/effects.js";
import { summarize } from "../engine/run.js";
import { type PlanInput, parseInboxSpec } from "../workflows/domain/index.js";
import { registerAuthCommands } from "./cli-auth.js";
import { registerRecordCommands } from "./cli-record.js";
import { ingress } from "./client.js";
import { loadEnvFile, loadSettings } from "./config.js";
import { WORKFLOWS } from "./services.js";

loadEnvFile();
const settings = loadSettings();
const api = ingress({
  url: settings.restateIngressUrl,
  authToken: settings.restateAuthToken ?? null,
});

const program = new Command("autobrowse").showHelpAfterError();

program
  .command("workflows")
  .description("What this worker can run")
  .action(() => {
    for (const w of WORKFLOWS)
      console.log(
        `${w.name.padEnd(12)} ${w.description}  [${w.steps.map((s) => s.name).join(" → ")}]`,
      );
  });

program
  .command("run <workflow> <key>")
  .description("Start a run from a plan file (JSON); omit --plan to resume the stored one")
  .option("--plan <file>")
  .option("--dry-run")
  .action(async (workflow: string, key: string, o: { plan?: string; dryRun?: boolean }) => {
    const plan = o.plan
      ? (JSON.parse(await readFile(o.plan, "utf8")) as Record<string, unknown>)
      : null;
    await api.run(workflow, key).run(plan ? { ...plan, dryRun: o.dryRun ?? false } : null);
    console.log(
      `${plan ? "started" : "resumed"} ${workflow}/${key}; watch: autobrowse status ${workflow} ${key}`,
    );
  });

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
      await api.run("domain", domain).run(plan);
      console.log(`started domain/${domain}; watch: autobrowse status domain ${domain}`);
    },
  );

for (const verb of ["approve", "reject"] as const) {
  program
    .command(`${verb} <workflow> <key> <gate>`)
    .option("--note <text>")
    .action(async (workflow: string, key: string, gate: GateName, o: { note?: string }) => {
      const g = await api
        .run(workflow, key)
        [verb]({ name: gate, ...(o.note ? { note: o.note } : {}) });
      console.log(`${verb}d ${g.name} at ${g.step} (opened ${g.openedAt})`);
    });
}

for (const verb of ["pause", "play", "reset"] as const) {
  program.command(`${verb} <workflow> <key>`).action(async (workflow: string, key: string) => {
    await api.run(workflow, key)[verb]();
    console.log(`${verb} ${workflow}/${key}`);
  });
}

program.command("status <workflow> <key>").action(async (workflow: string, key: string) => {
  const s = await api.run(workflow, key).status();
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
  .description("Every run the registry knows, newest first")
  .action(async () => {
    for (const r of await api.registry().list())
      console.log(
        `${r.status.padEnd(9)} ${`${r.workflow}/${r.key}`.padEnd(40)} ${r.gate ? `gate:${r.gate}` : (r.lastStep ?? "")}  ${r.updatedAt}`,
      );
  });

registerRecordCommands(program, settings);
registerAuthCommands(program, settings);

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
