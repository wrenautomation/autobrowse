/** `autobrowse login <site>` and `autobrowse record <name>`: the recorder's command line. */
import { join } from "node:path";
import type { Command } from "commander";
import type { Settings } from "./config.js";
import { browserOptions, gmailFor, llmFor, loginFor } from "./services.js";

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
        const { startExplore } = await import("../explore/server.js");
        const { exploreWithAgent } = await import("../agent/explorer.js");
        const llm = llmFor(settings);
        if (!llm) throw new Error("the agent needs a model: set LLM_PROVIDER and its key");
        const ex = await startExplore({
          site,
          browser: browserOptions(settings, false),
          recordingsDir: settings.recordingsDir,
          port: Number(o.port),
          login: loginFor(settings, gmailFor(settings)),
        });
        console.log(
          `agent on ${site}; pause/resume: curl -s -X POST -H "Authorization: Bearer ${ex.token}" http://127.0.0.1:${ex.port}/ -d '{"cmd":"pause"}'`,
        );
        if (o.url) await ex.exec({ cmd: "open", url: o.url });
        const inputs = Object.fromEntries(
          (o.input ?? []).map((kv) => {
            const i = kv.indexOf("=");
            return [kv.slice(0, i), kv.slice(i + 1)];
          }),
        );
        const result = await exploreWithAgent({
          explorer: ex,
          llm,
          goal,
          inputs,
          maxSteps: Number(o.maxSteps),
          onStep: (r) =>
            console.log(
              `${r.n}. ${r.step?.thought ?? "(unparsable reply)"}\n   ${r.step?.action.cmd ?? "-"} ${r.error ? `✗ ${r.error}` : "✓"}`,
            ),
        });
        console.log(`${result.achieved ? "achieved" : "not achieved"}: ${result.summary}`);
        console.log(`tokens in ${result.usage.inputTokens} out ${result.usage.outputTokens}`);
        const name =
          o.save ??
          goal
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 40);
        const saved = (await ex.exec({ cmd: "save", name })) as { dir: string };
        console.log(`recording: ${saved.dir}  →  pnpm autobrowse compile ${name}`);
        await ex.exec({ cmd: "close" });
      },
    );

  program
    .command("compile <name>")
    .description("Recording → outline.json beside it → a workflow module under --out")
    .option("--out <dir>", "where the module goes", "src/workflows")
    .option("--lib <module>", "what the module imports the library as", "autobrowse")
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
