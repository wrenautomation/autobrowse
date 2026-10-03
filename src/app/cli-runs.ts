/**
 * Runs, walks and tokens from the terminal.
 *
 * - `explored [site]`: every explore session's history (src/runs), newest last;
 *   `explored show <run>`: its shape (commands, acts, pages, outcome), never a value.
 * - `walks build|list|show|run`: a deterministic flow built from the runs
 *   that reached a goal (src/walks), then run like any catalog flow.
 * - `tokens`: what autobrowse spends, and the verdict against tools that
 *   send the whole page (src/runs/tokens).
 */

import type { Command } from "commander";
import { readLlmCalls } from "../llm/ledger.js";
import { baseSite, listRuns, openRuns, readRun, runFile } from "../runs/log.js";
import { formatTokenReport, readCmds, tokenReport } from "../runs/tokens.js";
import { accent, columns, dim, good, warn } from "../style.js";
import { buildWalk } from "../walks/build.js";
import { walkFlowName } from "../walks/flow.js";
import { listWalks, loadWalk, saveWalk, walkFile } from "../walks/spec.js";
import type { LocalBackend } from "./backend.js";
import type { Settings } from "./config.js";
import { llmCallsDirFor, runsDirFor, stepLedgerFor, walkFor, walksDirFor } from "./services.js";

/** Page text can hold an address (an account chooser); structure output never shows one. */
const masked = (s: string): string => s.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>");

/** `site/name` or the catalog's `site/walk-name`: the name as given when a walk has it, else without `walk-`. */
const walkRefIn =
  (dir: string) =>
  (ref: string): [string, string] => {
    const slash = ref.indexOf("/");
    const site = ref.slice(0, slash);
    const name = ref.slice(slash + 1);
    if (slash < 0 || !name.startsWith("walk-") || loadWalk(dir, site, name)) return [site, name];
    return [site, name.slice(5)];
  };

const k = (n: number): string =>
  n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US");

export function registerRunsCommands(
  program: Command,
  settings: Settings,
  local: LocalBackend,
): void {
  const runsDir = runsDirFor(settings);
  const walksDir = walksDirFor(settings);
  const walkRef = walkRefIn(walksDir);

  const explored = program
    .command("explored [site]")
    .description("Explore runs, newest last: driver, goal, outcome, commands, answer tokens")
    .option("-n, --last <n>", "how many", "30")
    .option("--json", "one summary per line")
    .action((site: string | undefined, o: { last: string; json?: boolean }) => {
      const all = listRuns(runsDir).filter((r) => !site || baseSite(r.site) === baseSite(site));
      const shown = all.slice(-Number(o.last));
      if (o.json) {
        for (const r of shown) console.log(JSON.stringify(r));
        return;
      }
      const paint = (outcome: string) =>
        (outcome === "achieved" || outcome === "saved" ? good : outcome === "closed" ? dim : warn)(
          outcome,
        );
      const rows = shown.map((r) => [
        dim(r.run),
        accent(r.site),
        paint(r.outcome),
        r.driver,
        `${String(r.cmds).padStart(4)} cmd`,
        `${k(r.tokens).padStart(6)} tok`,
        masked(r.goal ?? "-").slice(0, 60),
      ]);
      for (const line of columns(rows)) console.log(line);
      const open = openRuns(runsDir).filter((r) => !site || r.site === baseSite(site));
      if (open.length)
        console.log(`${open.length} still open (no end yet): ${open.map((r) => r.run).join(", ")}`);
      if (!all.length && !open.length) console.log("no runs yet: every explore session writes one");
    });

  explored
    .command("show <run>")
    .description(
      "One run's shape: commands, acts and the pages they were on, how it ended; never typed values",
    )
    .action((id: string) => {
      const known =
        listRuns(runsDir).find((r) => r.run === id) ?? openRuns(runsDir).find((r) => r.run === id);
      if (!known) throw new Error(`no run ${id}; see: autobrowse explored`);
      const rows = readRun(runFile(runsDir, known.site, id));
      for (const r of rows) {
        const t = r.at.slice(11, 19);
        if (r.kind === "start")
          console.log(`${t} start  ${r.driver}${r.resumed ? " (resumed)" : ""} on ${r.machine}`);
        else if (r.kind === "goal") console.log(`${t} goal   ${masked(r.goal)}`);
        else if (r.kind === "cmd")
          console.log(
            `${t} cmd    #${r.n} ${r.cmd.padEnd(10)} ${r.ok ? "ok " : "err"} ${String(r.tokens).padStart(6)} tok${r.full !== null ? ` (page ${k(Math.ceil(r.full / 4))})` : ""}  ${r.host}`,
          );
        else if (r.kind === "act")
          console.log(
            `${t} act    ${r.act.kind.padEnd(9)}${r.hand ? " by hand" : ""}${r.look ? `  ${r.look.url} [${r.look.landmarks.length} landmarks]` : ""}`,
          );
        else console.log(`${t} end    ${r.outcome}${r.look ? `  ${r.look.url}` : ""}`);
      }
    });

  const walks = program
    .command("walks")
    .description(
      "Deterministic flows built from runs that reached a goal; run as <site>/walk-<name>",
    );

  walks
    .command("build <site> <name>")
    .description(
      "Build a walk from ended runs on a site (achieved or saved), newest wins where they differ",
    )
    .option("--run <ids>", "comma-separated run ids")
    .option("--goal-like <words>", "every run whose goal has all these words")
    .option("--goal <text>", "what the walk does (default: the newest run's goal)")
    .action((site: string, name: string, o: { run?: string; goalLike?: string; goal?: string }) => {
      const built = buildWalk(runsDir, {
        site,
        name,
        ...(o.goal ? { goal: o.goal } : {}),
        ...(o.run ? { runs: o.run.split(",").map((s) => s.trim()) } : {}),
        ...(o.goalLike ? { goalLike: o.goalLike } : {}),
      });
      saveWalk(walksDir, built.spec);
      const s = built.spec;
      console.log(
        `${s.site}/${walkFlowName(s)}: ${s.screens.length} screens from ${built.used.length} run(s)`,
      );
      for (const x of built.skipped) console.log(`  skipped ${x.run}: ${x.reason}`);
      for (const d of built.disagreements) console.log(`  differs: ${masked(d)}`);
      if (s.fields.length) console.log(`  plan: ${s.fields.map((f) => f.key).join(", ")}`);
      if (s.secrets.length) console.log(`  secrets: ${s.secrets.map((x) => x.key).join(", ")}`);
      if (s.irreversible) console.log("  irreversible: walks run needs --yes");
      console.log(`  ${walkFile(walksDir, s.site, s.name)}`);
    });

  walks
    .command("list")
    .description("Walks on this machine")
    .action(() => {
      const all = listWalks(walksDir);
      const rows = all.map((w) => [
        `${w.irreversible ? warn("!") : " "} ${accent(`${w.site}/walk-${w.name}`)}`,
        `${String(w.screens).padStart(3)} screens`,
        `${String(w.runs).padStart(3)} runs`,
        dim(masked(w.goal).slice(0, 50)),
      ]);
      for (const line of columns(rows)) console.log(line);
      if (!all.length)
        console.log("no walks yet: autobrowse walks build <site> <name> --goal-like <words>");
    });

  walks
    .command("show <walk>")
    .description("A walk's screens and ops (<site>/<name>); never the example values")
    .action((ref: string) => {
      const [site, name] = walkRef(ref);
      const s = site && name ? loadWalk(walksDir, site, name) : null;
      if (!s) throw new Error(`no walk ${ref}; see: autobrowse walks list`);
      console.log(`${s.site}/${walkFlowName(s)}: ${masked(s.goal)}`);
      console.log(
        `  built ${s.built} from ${s.from.map((f) => `${f.run} (${f.outcome})`).join(", ")}`,
      );
      console.log(`  start ${s.start ?? "(current page)"}`);
      if (s.fields.length) console.log(`  plan: ${s.fields.map((f) => f.key).join(", ")}`);
      if (s.secrets.length) console.log(`  secrets: ${s.secrets.map((x) => x.key).join(", ")}`);
      for (const sc of s.screens) {
        const after = sc.after?.length ? ` after ${sc.after.join(",")}` : "";
        console.log(
          `  ${sc.name}${sc.goal ? " (goal)" : ""}${sc.once ? " once" : ""}${after}  ${sc.url ?? "any url"} [${sc.landmarks.length} landmarks, seen ${sc.seen}x]`,
        );
        for (const op of sc.ops) {
          const h = "hints" in op ? op.hints : null;
          const at = h ? ` ${h.role ?? h.tag ?? ""}${h.name ? ` "${masked(h.name)}"` : ""}` : "";
          const from =
            op.kind === "fill"
              ? ` ← ${op.value.from === "literal" ? "literal" : op.value.from === "plan" ? `plan.${op.value.field}` : `secret ${op.value.key}`}`
              : op.kind === "walk"
                ? ` → ${op.walk}`
                : "";
          console.log(`    ${op.kind}${at}${from}`);
        }
      }
    });

  walks
    .command("run <walk>")
    .description(
      "Run a walk in a browser here (<site>/<name>); --plan key=value for its plan fields",
    )
    .option("--plan <kv...>", "plan fields, key=value")
    .option("--yes", "allow a walk with an irreversible act")
    .option("--headed", "show the browser")
    .action(async (ref: string, o: { plan?: string[]; yes?: boolean; headed?: boolean }) => {
      const [site, name] = walkRef(ref);
      const s = site && name ? loadWalk(walksDir, site, name) : null;
      if (!s) throw new Error(`no walk ${ref}; see: autobrowse walks list`);
      if (s.irreversible && !o.yes)
        throw new Error(`${ref} has an irreversible act; say --yes to run it`);
      const input: Record<string, string> = {};
      for (const kv of o.plan ?? []) {
        const i = kv.indexOf("=");
        if (i < 1) throw new Error(`--plan ${kv}: want key=value`);
        input[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const { parts } = local({ headless: o.headed ? false : settings.browserHeadless });
      const flow = walkFor(settings, `${s.site}/${walkFlowName(s)}`, parts.sink);
      if (!flow) throw new Error(`no walk ${ref}`);
      const out = await parts.browser.run(flow, input);
      console.log(`reached ${out.goal} via ${out.screens.join(" → ") || "(already there)"}`);
      if (Object.keys(out.read).length) console.log(`read: ${Object.keys(out.read).join(", ")}`);
      if (out.kept.length) console.log(`kept: ${out.kept.join(", ")}`);
    });

  program
    .command("tokens")
    .description(
      "Token spend: model calls by purpose, explore answers against whole-page reads, and the verdict",
    )
    .option("--days <n>", "window, in days", "30")
    .option("--json", "the report as JSON")
    .action(async (o: { days: string; json?: boolean }) => {
      const until = new Date().toISOString();
      const since = new Date(Date.now() - Number(o.days) * 86_400_000).toISOString();
      const report = tokenReport({
        since,
        until,
        calls: readLlmCalls(llmCallsDirFor(settings), since),
        cmds: readCmds(runsDir, since),
        steps: await stepLedgerFor(settings).recent(100_000),
      });
      if (o.json) console.log(JSON.stringify(report, null, 2));
      else for (const line of formatTokenReport(report)) console.log(line);
    });
}
