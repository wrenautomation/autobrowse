/** `autobrowse login <site>` and `autobrowse record <name>`: the recorder's command line. */
import { join } from "node:path";
import type { Command } from "commander";
import type { Settings } from "./config.js";
import { browserOptions, llmFor } from "./services.js";

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
      });
      console.log(
        `exploring ${site} on http://127.0.0.1:${ex.port}  (POST {"cmd":"aria"} … {"cmd":"close"})`,
      );
      if (o.url)
        await fetch(`http://127.0.0.1:${ex.port}/`, {
          method: "POST",
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
