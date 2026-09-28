/**
 * `autobrowse access`: one key per agent, naming what it may see and call
 * (`access/keys`). The key is printed once, at `add`; only its hash is kept.
 */
import type { Command } from "commander";
import { fileKeys, type ScopeRules, VERBS, type Verb } from "../access/keys.js";
import { expandHome } from "../google-auth.js";
import type { Settings } from "./config.js";

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function registerAccessCommands(program: Command, settings: Settings): void {
  const store = () => fileKeys(expandHome(settings.accessFile));
  const access = program
    .command("access")
    .description(
      "What each agent may use: one key per agent, naming its sites, workflows and tools",
    );
  access
    .command("grant <name>")
    .description("Make the agent's key (printed once); granting a name again replaces its key")
    .option("--sites <list>", "sites and accounts: github, github@wren, github@*")
    .option("--workflows <list>", "compiled workflows; a trailing * is a prefix")
    .option("--tools <list>", "command-line tools by name")
    .option("--can <list>", `verbs: ${VERBS.join(", ")}`, "do")
    .action(
      (name: string, o: { sites?: string; workflows?: string; tools?: string; can?: string }) => {
        const can = list(o.can);
        const bad = can.filter((v) => !(VERBS as readonly string[]).includes(v));
        if (bad.length) throw new Error(`unknown verb ${bad.join(", ")}: ${VERBS.join(", ")}`);
        const rules: ScopeRules = {
          sites: list(o.sites),
          workflows: list(o.workflows),
          tools: list(o.tools),
          can: can as Verb[],
        };
        const { key, stored } = store().add(name, rules);
        console.log(key);
        console.error(
          `${stored.name}: ${describe(stored)}. Shown once: give it to the agent as its bearer.`,
        );
      },
    );
  access
    .command("list")
    .description("Every key: its name and what it may use (never the key)")
    .action(() => {
      const all = store().list();
      if (!all.length) console.log("no agent has access");
      for (const k of all)
        console.log(`${k.name}  ${describe(k)}  (made ${k.createdAt.slice(0, 10)})`);
    });
  access
    .command("revoke <name>")
    .description("Drop a key: the next request with it is refused")
    .action((name: string) => {
      if (!store().revoke(name)) {
        console.log(`no key named ${name}`);
        process.exitCode = 1;
        return;
      }
      console.log(`${name} revoked`);
    });
}

function describe(r: ScopeRules): string {
  const part = (label: string, v: string[]) => (v.length ? `${label} ${v.join(",")}` : null);
  return (
    [
      part("sites", r.sites),
      part("workflows", r.workflows),
      part("tools", r.tools),
      part("can", r.can),
    ]
      .filter(Boolean)
      .join("; ") || "nothing"
  );
}
