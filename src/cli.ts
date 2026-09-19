#!/usr/bin/env tsx
/** `provision`: start a domain, answer its gates, read its status, log into a site once. */
import * as clients from "@restatedev/restate-sdk-clients";
import { Command } from "commander";
import { openSession } from "./browser/session.js";
import { loadEnvFile, loadSettings } from "./config.js";
import type { PlanInput } from "./flow/plan.js";
import type { DomainProvision } from "./restate/domain-provision.js";
import { summarize } from "./restate/domain-provision.js";

loadEnvFile();
const settings = loadSettings();

function object(domain: string) {
  const ingress = clients.connect({
    url: settings.restateIngressUrl,
    ...(settings.restateAuthToken
      ? { headers: { authorization: `Bearer ${settings.restateAuthToken}` } }
      : {}),
  });
  return ingress.objectClient<DomainProvision>({ name: "DomainProvision" }, domain);
}

const program = new Command("provision").showHelpAfterError();

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
      const inboxes = o.inbox.map((s) => {
        const [local, givenName, familyName] = s.split(":");
        if (!local || !givenName || !familyName)
          throw new Error(`--inbox wants local:Given:Family, got ${s}`);
        return { local, givenName, familyName };
      });
      const plan: PlanInput = {
        domain,
        inboxes,
        niches: o.niches === "all" ? "all" : o.niches.split(",").map((s) => s.trim()),
        ...(o.signatureFile
          ? {
              signatureHtml: await (await import("node:fs/promises")).readFile(
                o.signatureFile,
                "utf8",
              ),
            }
          : {}),
        buy: o.buy,
        warmup: o.warmup,
        handoff: o.handoff,
        dryRun: o.dryRun ?? false,
      };
      // Fire and forget: the run parks at gates for as long as it takes.
      const ingress = clients.connect({
        url: settings.restateIngressUrl,
        ...(settings.restateAuthToken
          ? { headers: { authorization: `Bearer ${settings.restateAuthToken}` } }
          : {}),
      });
      await ingress
        .objectSendClient<DomainProvision>({ name: "DomainProvision" }, domain)
        .run(plan);
      console.log(`started ${domain}; watch with: provision status ${domain}`);
    },
  );

program
  .command("resume <domain>")
  .description("Re-run the stored plan (after a failure or a fix)")
  .action(async (domain: string) => {
    const ingress = clients.connect({
      url: settings.restateIngressUrl,
      ...(settings.restateAuthToken
        ? { headers: { authorization: `Bearer ${settings.restateAuthToken}` } }
        : {}),
    });
    await ingress.objectSendClient<DomainProvision>({ name: "DomainProvision" }, domain).run(null);
    console.log(`resumed ${domain}`);
  });

program
  .command("approve <domain> <gate>")
  .option("--note <text>")
  .action(async (domain: string, gate: string, o: { note?: string }) => {
    const g = await object(domain).approve({ name: gate, ...(o.note ? { note: o.note } : {}) });
    console.log(`approved ${g.name} (opened ${g.openedAt})`);
  });

program
  .command("reject <domain> <gate>")
  .option("--note <text>")
  .action(async (domain: string, gate: string, o: { note?: string }) => {
    const g = await object(domain).reject({ name: gate, ...(o.note ? { note: o.note } : {}) });
    console.log(`rejected ${g.name}`);
  });

program.command("status <domain>").action(async (domain: string) => {
  const s = await object(domain).status();
  if (s.gate) console.log(`GATE ${s.gate.name} since ${s.gate.openedAt}: ${s.gate.message}`);
  console.log(s.outcome ? summarize(s.outcome) : "no run yet");
});

program
  .command("reset <domain>")
  .description("Forget this domain's run; a run parked at a gate is cancelled first")
  .action(async (domain: string) => {
    const cancelled = await object(domain).cancel(null);
    if (cancelled) console.log("cancelled the run at its gate");
    await object(domain).reset();
    console.log(`reset ${domain}`);
  });

program
  .command("record <site>")
  .description(
    "Open a headed browser on the site's persistent profile; log in, then close it. cloudflare | google-admin | instantly",
  )
  .action(async (site: string) => {
    const urls: Record<string, string> = {
      cloudflare: "https://dash.cloudflare.com/login",
      "google-admin": "https://admin.google.com/",
      instantly: "https://app.instantly.ai/",
    };
    const url = urls[site];
    if (!url) throw new Error(`unknown site ${site}; one of ${Object.keys(urls).join(", ")}`);
    const session = await openSession(site, {
      tier: "local",
      profilesDir: settings.profilesDir,
      headless: false,
    });
    await session.page.goto(url);
    console.log("log in, then close the browser window");
    await new Promise<void>((resolve) => session.page.context().on("close", () => resolve()));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
