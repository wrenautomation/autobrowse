/** `autobrowse login <site>` and `autobrowse record <name>`: the recorder's command line. */
import { join } from "node:path";
import type { Command } from "commander";
import { expandHome } from "../google-auth.js";
import type { Settings } from "./config.js";
import { browserOptions, gmailFor, llmFor, loginFor, paceFor } from "./services.js";

export function registerRecordCommands(program: Command, settings: Settings): void {
  program
    .command("explore <site>")
    .description(
      "Keep one browser open on the site and take commands over loopback (POST JSON to /); every act that works is journaled; `save` writes a recording",
    )
    .option("--url <url>", "start here")
    .option("--port <port>", "loopback port", "9090")
    .action(async (site: string, o: { url?: string; port: string }) => {
      const { startExplore } = await import("../explore/server.js");
      const ex = await startExplore({
        site,
        browser: browserOptions(settings, false),
        recordingsDir: settings.recordingsDir,
        port: Number(o.port),
        login: loginFor(settings, gmailFor(settings)),
      });
      console.log(
        `exploring ${site} on http://127.0.0.1:${ex.port}\ntoken ${ex.token}\ncurl -s -X POST -H "Authorization: Bearer ${ex.token}" http://127.0.0.1:${ex.port}/ -d '{"cmd":"aria"}'`,
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
    .command("record <name>")
    .description(
      "Record a chore: a headed browser with an observer, play/pause from this terminal, optional terminal capture",
    )
    .option("--site <site>", "use this site's logged-in profile", "scratch")
    .option("--url <url>", "start here")
    .option("--terminal", "also record a shell session in this terminal after the browser closes")
    .action(async (name: string, o: { site: string; url?: string; terminal?: boolean }) => {
      const { recordChore } = await import("../recorder/index.js");
      const opts = browserOptions(settings, false);
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
    .action(
      async (
        site: string,
        goal: string,
        o: { url?: string; input?: string[]; save?: string; maxSteps: string; port: string },
      ) => {
        await runAgent(settings, {
          site,
          goal,
          url: o.url ?? null,
          inputs: parseInputs(o.input),
          save: o.save ?? slug(goal),
          maxSteps: Number(o.maxSteps),
          port: Number(o.port),
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
    .action(
      async (
        failure: string,
        goal: string | undefined,
        o: { input?: string[]; maxSteps: string; port: string },
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
      const { healFailure, healLine } = await import("../agent/heal.js");
      const { readFailure } = await import("../agent/repair.js");
      const { agentSessions } = await import("../agent/sessions.js");
      const { startExplore } = await import("../explore/server.js");
      const { COMPILED_DIR, COMPILED_LIB } = await import("./services.js");
      const llm = llmFor(settings);
      if (!llm) throw new Error("heal needs a model: set a model key or LLM_PROVIDER=claude-code");
      const recordingsDir = expandHome(settings.recordingsDir);
      const agent = agentSessions({
        llm,
        dir: join(recordingsDir, ".sessions"),
        open: (site, port) =>
          startExplore({
            site,
            browser: browserOptions(settings, false),
            recordingsDir,
            port,
            login: loginFor(settings, gmailFor(settings)),
            pace: paceFor(settings),
          }),
      });
      const record = readFailure(failure, expandHome(settings.artifactsDir));
      const out = await healFailure(record, {
        agent,
        compiledDir: COMPILED_DIR,
        recordingsDir,
        lib: COMPILED_LIB,
        ...(o.prove
          ? {
              prove: async (name: string) => {
                const { loadCompiledWorkflows } = await import("../workflows/compiled.js");
                const { proofLine, proveWorkflow, writeProof } = await import(
                  "../workflows/proof.js"
                );
                const { flowRunner } = await import("../browser/flow.js");
                const found = (await loadCompiledWorkflows(COMPILED_DIR)).find(
                  (c) => c.workflow.name === name,
                );
                if (!found) throw new Error(`healed workflow ${name} did not load`);
                const proof = await proveWorkflow(
                  found.workflow,
                  flowRunner(browserOptions(settings), {
                    pace: paceFor(settings),
                    login: loginFor(settings, gmailFor(settings)),
                  }),
                );
                writeProof(found.dir, proof);
                return proofLine(proof);
              },
            }
          : {}),
      });
      console.log(healLine(out));
      if (out.status !== "healed") process.exitCode = 1;
    });
  program
    .command("compile <name>")
    .description("Recording → outline.json beside it → a workflow module under --out")
    .option("--out <dir>", "where the module goes", "src/workflows")
    .option("--lib <module>", "what the module imports the library as", "../../index.js")
    .option("--no-llm", "skip the model pass (names, proofs); pure template output")
    .option("--from-outline", "re-render an edited outline.json instead of re-structuring")
    .action(
      async (
        name: string,
        o: { out: string; lib: string; llm: boolean; fromOutline?: boolean },
      ) => {
        const { compile, loadOutline, saveOutline, writeRendered } = await import(
          "../compiler/index.js"
        );
        const { loadRecording, recordingDir } = await import("../recorder/store.js");
        const dir = recordingDir(settings.recordingsDir, name);
        const llm = o.llm ? llmFor(settings) : null;
        if (o.llm && !llm) console.log("no model key set; template output only");
        let out: Awaited<ReturnType<typeof compile>>;
        if (o.fromOutline) {
          const { render } = await import("../compiler/render.js");
          const outline = await loadOutline(dir);
          out = { outline, usage: null, ...render(outline, { lib: o.lib }) };
        } else {
          out = await compile(await loadRecording(settings.recordingsDir, name), {
            llm,
            lib: o.lib,
          });
          await saveOutline(dir, out.outline);
        }
        const files = await writeRendered(join(o.out, out.outline.name), out);
        for (const f of files) console.log(f);
        if (out.usage)
          console.log(`model: ${out.usage.inputTokens} in / ${out.usage.outputTokens} out`);
        console.log(
          `steps: ${out.outline.steps.map((s) => `${s.name}${s.irreversible ? "!" : ""}`).join(" → ")}`,
        );
      },
    );
}

interface AgentRun {
  site: string;
  goal: string;
  url: string | null;
  inputs: Record<string, string>;
  save: string;
  maxSteps: number;
  port: number;
}

/** One agent session: explore server up, agent to the goal, journal saved as a recording. */
async function runAgent(settings: Settings, r: AgentRun): Promise<void> {
  const { startExplore } = await import("../explore/server.js");
  const { exploreWithAgent } = await import("../agent/explorer.js");
  const llm = llmFor(settings);
  if (!llm) throw new Error("the agent needs a model: set LLM_PROVIDER and its key");
  const ex = await startExplore({
    site: r.site,
    browser: browserOptions(settings, false),
    recordingsDir: settings.recordingsDir,
    port: r.port,
    login: loginFor(settings, gmailFor(settings)),
    pace: paceFor(settings),
  });
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
      maxSteps: r.maxSteps,
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
