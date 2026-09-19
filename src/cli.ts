#!/usr/bin/env tsx
/** `autobrowse`: start a domain, answer its gates, pause and play, log into a site once, record a flow. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as clients from "@restatedev/restate-sdk-clients";
import { Command } from "commander";
import { SITES, type Site } from "./browser/flow.js";
import { openSession } from "./browser/session.js";
import { loadEnvFile, loadSettings } from "./config.js";
import type { GateName } from "./flow/effects.js";
import { type PlanInput, parseInboxSpec } from "./flow/plan.js";
import { expandHome } from "./google-auth.js";
import type { DomainProvision } from "./restate/domain-provision.js";
import { summarize } from "./restate/domain-provision.js";
import { browserOptions } from "./services.js";

loadEnvFile();
const settings = loadSettings();

const ingress = clients.connect({
  url: settings.restateIngressUrl,
  ...(settings.restateAuthToken
    ? { headers: { authorization: `Bearer ${settings.restateAuthToken}` } }
    : {}),
});
const object = (domain: string) =>
  ingress.objectClient<DomainProvision>({ name: "DomainProvision" }, domain);

const program = new Command("autobrowse").showHelpAfterError();

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
      await object(domain).run(plan);
      console.log(`started ${domain}; watch with: autobrowse status ${domain}`);
    },
  );

program
  .command("resume <domain>")
  .description("Re-run the stored plan (after a failure or a fix)")
  .action(async (domain: string) => {
    await object(domain).run(null);
    console.log(`resumed ${domain}`);
  });

for (const verb of ["approve", "reject"] as const) {
  program
    .command(`${verb} <domain> <gate>`)
    .option("--note <text>")
    .action(async (domain: string, gate: GateName, o: { note?: string }) => {
      const g = await object(domain)[verb]({ name: gate, ...(o.note ? { note: o.note } : {}) });
      console.log(`${verb}d ${g.name} at ${g.step} (opened ${g.openedAt})`);
    });
}

program
  .command("pause <domain>")
  .description("Stop before the next step")
  .action(async (domain: string) => {
    await object(domain).pause();
    console.log(`paused ${domain}`);
  });

program
  .command("play <domain>")
  .description("Run on after a pause")
  .action(async (domain: string) => {
    await object(domain).play();
    console.log(`playing ${domain}`);
  });

program.command("status <domain>").action(async (domain: string) => {
  const s = await object(domain).status();
  if (s.paused) console.log("PAUSED");
  if (s.gate) {
    console.log(`GATE ${s.gate.name} at ${s.gate.step} since ${s.gate.openedAt}: ${s.gate.prompt}`);
    if (s.gate.screenshot) console.log(`  screenshot ${s.gate.screenshot}`);
    if (s.gate.trace) console.log(`  trace      npx playwright show-trace ${s.gate.trace}`);
  }
  console.log(s.outcome ? summarize(s.outcome) : "no run yet");
});

program
  .command("reset <domain>")
  .description("Forget this domain's run, gate and all")
  .action(async (domain: string) => {
    await object(domain).reset();
    console.log(`reset ${domain}`);
  });

program
  .command("record <site>")
  .description(
    `Open a headed browser on the site's persistent profile to log in; with --flow, run Playwright codegen on it and save the recording. Sites: ${Object.keys(SITES).join(", ")}`,
  )
  .option("--flow <name>", "record a flow into RECORDINGS_DIR/<site>/<name>.ts")
  .option("--url <url>", "start somewhere other than the site's home")
  .action(async (site: string, o: { flow?: string; url?: string }) => {
    if (!(site in SITES))
      throw new Error(`unknown site ${site}; one of ${Object.keys(SITES).join(", ")}`);
    const url = o.url ?? SITES[site as Site].home;
    const opts = browserOptions(settings, false);
    if (opts.tier !== "local") throw new Error("record needs BROWSER=local");
    if (o.flow) {
      const out = join(settings.recordingsDir, site, `${o.flow}.ts`);
      const profile = join(expandHome(opts.profilesDir), site);
      const args = [
        "playwright",
        "codegen",
        "--user-data-dir",
        profile,
        "--target",
        "playwright-test",
        "-o",
        out,
        url,
      ];
      console.log(`recording to ${out}; do the flow, then close the window`);
      await new Promise<void>((resolve, reject) => {
        const p = spawn("npx", args, { stdio: "inherit" });
        p.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`codegen exited ${code}`)),
        );
      });
      console.log(
        `saved ${out}. It may hold typed secrets: transcribe it into src/browser/flows, never commit it.`,
      );
      return;
    }
    const session = await openSession(site, opts);
    await session.page.goto(url);
    console.log("log in, then close the browser window");
    await new Promise<void>((resolve) => session.context.on("close", () => resolve()));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
