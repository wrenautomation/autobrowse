/** `autobrowse login <site>` and `autobrowse record <name>`: the recorder's command line. */
import { join } from "node:path";
import type { Command } from "commander";
import type { SecretValues } from "../auth/signup.js";
import { explorerOpener, type LocalBackend } from "./backend.js";
import type { Settings } from "./config.js";
import { headed } from "./screen.js";
import { browserOptions, COMPILED_DIR, llmFor } from "./services.js";

export function registerRecordCommands(
  program: Command,
  settings: Settings,
  local: LocalBackend,
): void {
  /** Headless as the env says unless the person asks to watch. */
  const opener = (o: { headed?: boolean }) =>
    explorerOpener(settings, undefined, o.headed ? headed : undefined);
  program
    .command("explore <site>")
    .description(
      "Keep one browser open on the site and take commands over loopback (POST JSON to /); every act that works is journaled; `save` writes a recording",
    )
    .option("--url <url>", "start here")
    .option("--port <port>", "loopback port", "9090")
    .option("--headed", "show the browser (default: BROWSER_HEADLESS)")
    .action(async (site: string, o: { url?: string; port: string; headed?: boolean }) => {
      const { tokenFileFor } = await import("../explore/server.js");
      const tokenFile = tokenFileFor(Number(o.port));
      const ex = await opener(o)(site, Number(o.port), { tokenFile });
      // The token lives in an owner-only file, not in this output: logs get pasted, files do not.
      console.log(
        `exploring ${site} on http://127.0.0.1:${ex.port}\ntoken file ${tokenFile}\ncurl -s -X POST -H "Authorization: Bearer $(cat ${tokenFile})" http://127.0.0.1:${ex.port}/ -d '{"cmd":"aria"}'`,
      );
      if (o.url)
        await fetch(`http://127.0.0.1:${ex.port}/`, {
          method: "POST",
          headers: { authorization: `Bearer ${ex.token}` },
          body: JSON.stringify({ cmd: "open", url: o.url }),
        });
      await ex.done;
    });

  program
    .command("mcp")
    .description(
      "Serve autobrowse as MCP tools over stdio for Claude Code: `claude mcp add autobrowse -- pnpm autobrowse mcp`",
    )
    .option("--port <port>", "first loopback port for sessions", "9300")
    .option("--headed", "show the browser (default: BROWSER_HEADLESS)")
    .action(async (o: { port: string; headed?: boolean }) => {
      const open = opener(o);
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const { buildMcpServer } = await import("../mcp/server.js");
      const { version } = JSON.parse(
        await import("node:fs").then((fs) =>
          fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
        ),
      ) as { version: string };
      let port = Number(o.port);
      const server = buildMcpServer({
        version,
        open: async (site, url) => {
          const ex = await open(site, port++);
          if (url) await ex.exec({ cmd: "open", url });
          return ex;
        },
        do: (req) => local().backend.do.do(req),
      });
      // stdout is the protocol: anything else goes to stderr.
      console.log = (...a: unknown[]) => console.error(...a);
      await server.connect(new StdioServerTransport());
    });

  program
    .command("record <name>")
    .description(
      "Record a chore: a headed browser with an observer, play/pause from this terminal, optional terminal capture",
    )
    .option("--site <site>", "use this site's logged-in profile", "scratch")
    .option("--url <url>", "start here")
    .option("--terminal", "also record a shell session in this terminal after the browser closes")
    .action(async (name: string, o: { site: string; url?: string; terminal?: boolean }) => {
      const { recordChore } = await import("../recorder/index.js");
      const opts = browserOptions(settings, headed); // a person records: they need to see it
      if (opts.tier !== "local") throw new Error("record needs BROWSER=local");
      const dir = await recordChore({
        name,
        site: o.site,
        startUrl: o.url ?? null,
        terminal: o.terminal ?? false,
        recordingsDir: settings.recordingsDir,
        browser: opts,
        io: { stdin: process.stdin, stdout: process.stdout },
      });
      console.log(`recording saved to ${dir}`);
    });

  program
    .command("agent <site> <goal>")
    .description(
      "An agent explores the site toward the goal, journaling every act; `--save <name>` writes the recording to compile. Loopback stays open for pause/resume.",
    )
    .option("--url <url>", "start here")
    .option("--input <k=v...>", "named values the goal may use (a file path, a domain)")
    .option("--save <name>", "recording name; default = from the goal")
    .option("--max-steps <n>", "step budget", "25")
    .option("--port <port>", "loopback port", "9090")
    .option("--headed", "show the browser (default: BROWSER_HEADLESS)")
    .action(
      async (
        site: string,
        goal: string,
        o: {
          url?: string;
          input?: string[];
          save?: string;
          maxSteps: string;
          port: string;
          headed?: boolean;
        },
      ) => {
        await runAgent(settings, {
          site,
          goal,
          url: o.url ?? null,
          inputs: parseInputs(o.input),
          save: o.save ?? slug(goal),
          maxSteps: Number(o.maxSteps),
          port: Number(o.port),
          headed: o.headed ?? false,
        });
      },
    );

  program
    .command("signup <site>")
    .description(
      "Make an account: the password is minted and stored sealed under <site> first, then the agent fills the signup placing email/password/code/phone by name (it never sees them); hands off at a captcha",
    )
    .requiredOption(
      "--email <address>",
      "the account's address; its codes are read from this inbox",
    )
    .option("--inbox <address>", "read codes here instead (when --email is an alias of this inbox)")
    .option("--name <name>", "shown name")
    .option("--handle <handle>", "username or handle to ask for")
    .option("--birthday <date>", "when the form insists")
    .option("--url <url>", "the signup page (default: the site's home)")
    .option("--max-steps <n>", "step budget", "40")
    .option("--port <port>", "loopback port", "9090")
    .option("--headed", "show the browser (default: BROWSER_HEADLESS)")
    .action(
      async (
        site: string,
        o: {
          email: string;
          inbox?: string;
          name?: string;
          handle?: string;
          birthday?: string;
          url?: string;
          maxSteps: string;
          port: string;
          headed?: boolean;
        },
      ) => {
        const { mintCredential, SIGNUP_SECRETS, signupGoal, signupHosts, signupSecrets } =
          await import("../auth/signup.js");
        const { codesFor, credentialsFor, gmailFor, ourPhone } = await import("./services.js");
        const account = {
          site,
          email: o.email,
          ...pick(o, ["inbox", "name", "handle", "birthday"]),
        };
        const cred = await mintCredential(credentialsFor(settings), account);
        console.log(`stored a new credential for ${site} (creds list); now the signup`);
        const secrets = signupSecrets({
          cred,
          codes: codesFor(settings, gmailFor(settings)),
          since: new Date(),
          phone: ourPhone(settings),
        });
        await runAgent(settings, {
          site,
          goal: signupGoal(account),
          url: o.url ?? null,
          inputs: {},
          secrets: {
            names: SIGNUP_SECRETS,
            values: secrets,
            hosts: signupHosts(site, o.url ?? null),
          },
          save: `signup-${site}`,
          maxSteps: Number(o.maxSteps),
          port: Number(o.port),
          headed: o.headed ?? false,
        });
      },
    );

  program
    .command("repair <failure> [goal]")
    .description(
      "A flow stopped (its <stamp>.failure.json is under the artifacts dir): the agent picks up on that page toward the flow's goal, or the goal you give, and records the way through",
    )
    .option("--input <k=v...>", "named values the goal may use")
    .option("--max-steps <n>", "step budget", "25")
    .option("--port <port>", "loopback port", "9090")
    .option("--headed", "show the browser (default: BROWSER_HEADLESS)")
    .action(
      async (
        failure: string,
        goal: string | undefined,
        o: { input?: string[]; maxSteps: string; port: string; headed?: boolean },
      ) => {
        const { readFailure, repairGoal, repairName } = await import("../agent/repair.js");
        const record = readFailure(failure);
        console.log(`repairing ${record.site}/${record.flow} (${record.kind}: ${record.error})`);
        await runAgent(settings, {
          site: record.site,
          goal: repairGoal(record, goal),
          url: record.url,
          inputs: parseInputs(o.input),
          save: repairName(record),
          maxSteps: Number(o.maxSteps),
          port: Number(o.port),
          headed: o.headed ?? false,
        });
      },
    );

  program
    .command("heal <failure>")
    .description(
      "A failed compiled step: the agent finishes it on the page, the step is rewritten from what it did, the flow is proven again",
    )
    .option("--no-prove", "rewrite only; skip the proof run")
    .action(async (failure: string, o: { prove: boolean }) => {
      const { healLine } = await import("../agent/heal.js");
      const { readFailure } = await import("../agent/repair.js");
      const { backend } = local({ proveAfterHeal: o.prove });
      if (!backend.heal)
        throw new Error("heal needs a model: set a model key or LLM_PROVIDER=claude-code");
      const out = await backend.heal(readFailure(failure, backend.artifactsDir));
      console.log(healLine(out));
      if (out.status !== "healed") process.exitCode = 1;
    });
  program
    .command("compile <name>")
    .description(
      `Recording → workflow module under ${COMPILED_DIR}, with its editable outline.json beside it`,
    )
    .option("--no-llm", "skip the model pass (names, proofs); pure template output")
    .option("--from-outline", "re-render <name>'s edited outline.json instead of re-structuring")
    .action(async (name: string, o: { llm: boolean; fromOutline?: boolean }) => {
      const { loadRecording } = await import("../recorder/store.js");
      const { backend } = local({ llm: o.llm });
      if (o.llm && !backend.llm) console.log("no model key set; template output only");
      let out: Awaited<ReturnType<typeof backend.compile>>;
      if (o.fromOutline) {
        if (!backend.outline) throw new Error("no outline editor here");
        const outline = await backend.outline.load(name);
        if (!outline) throw new Error(`${name} has no outline.json under ${COMPILED_DIR}`);
        out = await backend.outline.save(name, outline);
      } else {
        out = await backend.compile(await loadRecording(backend.recordingsDir, name));
      }
      for (const f of Object.keys(out.files)) console.log(join(COMPILED_DIR, out.outline.name, f));
      if (out.usage)
        console.log(`model: ${out.usage.inputTokens} in / ${out.usage.outputTokens} out`);
      console.log(
        `steps: ${out.outline.steps.map((s) => `${s.name}${s.irreversible ? "!" : ""}`).join(" → ")}`,
      );
    });
}

interface AgentRun {
  site: string;
  goal: string;
  url: string | null;
  inputs: Record<string, string>;
  save: string;
  maxSteps: number;
  port: number;
  headed: boolean;
  /** Named values the agent may `place` and never sees; `hosts` says where they may land. */
  secrets?: { names: readonly string[]; values: SecretValues; hosts: (host: string) => boolean };
}

/** One agent session: explore server up, agent to the goal, journal saved as a recording. */
async function runAgent(settings: Settings, r: AgentRun): Promise<void> {
  const { exploreWithAgent } = await import("../agent/explorer.js");
  const llm = llmFor(settings);
  if (!llm) throw new Error("the agent needs a model: set LLM_PROVIDER and its key");
  const ex = await explorerOpener(settings, undefined, r.headed ? headed : undefined)(
    r.site,
    r.port,
    r.secrets ? { secrets: r.secrets.values, secretHosts: r.secrets.hosts } : {},
  );
  console.log(
    `agent on ${r.site}; pause/resume: curl -s -X POST -H "Authorization: Bearer ${ex.token}" http://127.0.0.1:${ex.port}/ -d '{"cmd":"pause"}'`,
  );
  try {
    if (r.url) await ex.exec({ cmd: "open", url: r.url });
    const result = await exploreWithAgent({
      explorer: ex,
      llm,
      goal: r.goal,
      inputs: r.inputs,
      ...(r.secrets ? { secrets: r.secrets.names } : {}),
      maxSteps: r.maxSteps,
      // Headed, the person does the captcha in the window and presses enter here.
      onHuman: async (reason) => {
        if (!r.headed) return false;
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const a = await rl.question(`needs you: ${reason}\nwhen done press enter (q to stop) `);
          return a.trim().toLowerCase() !== "q";
        } finally {
          rl.close();
        }
      },
      onStep: (s) =>
        console.log(
          `${s.n}. ${s.step?.thought ?? "(unparsable reply)"}\n   ${s.step?.action.cmd ?? "-"} ${s.error ? `✗ ${s.error}` : "✓"}`,
        ),
    });
    console.log(`${result.achieved ? "achieved" : "not achieved"}: ${result.summary}`);
    console.log(`tokens in ${result.usage.inputTokens} out ${result.usage.outputTokens}`);
    const saved = (await ex.exec({ cmd: "save", name: r.save })) as { dir: string };
    console.log(`recording: ${saved.dir}  →  pnpm autobrowse compile ${r.save}`);
  } finally {
    await ex.exec({ cmd: "close" });
  }
}

/** The keys of `o` that are set, as an object: options into a record without the undefined ones. */
function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function parseInputs(kvs: string[] | undefined): Record<string, string> {
  return Object.fromEntries(
    (kvs ?? []).map((kv) => {
      const i = kv.indexOf("=");
      return i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
}

/** A recording name from free text: lowercase, dashes, starts with a letter. */
function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
  return /^[a-z]/.test(s) ? s : `r-${s}`;
}
