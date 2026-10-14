/**
 * `autobrowse autotrack …`: the storage side of autotrack (autotrack repo designs/2026-10-13-autotrack.md). `enroll` makes
 * a write-only key for one device and prints its install code; `list` and `import` read sessions
 * back and turn one into a recording teach can read; `label` and `steps` derive the offline views.
 */
import { join } from "node:path";
import type { Command } from "commander";
import { checkDevice, installCommands } from "../autotrack/code.js";
import { devices, enroll, revoke } from "../autotrack/enroll.js";
import { importSession } from "../autotrack/import.js";
import { labelKey } from "../autotrack/label.js";
import { listSessions, type TrackWriter } from "../autotrack/store.js";
import { httpClient } from "../clients/http.js";
import { expandHome } from "../google-auth.js";
import type { Llm } from "../llm/index.js";
import { openaiLlm } from "../llm/openai.js";
import { isDefaultOwner } from "../owner.js";
import type { Settings } from "./config.js";
import { awsFor } from "./owner.js";
import { llmFor } from "./services.js";

const size = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : `${Math.ceil(n / 1e3)} KB`;

function operator(s: Settings): { bucket: string } {
  if (!isDefaultOwner(s.owner)) throw new Error(`owner ${s.owner}: track is the operator's`);
  if (!s.trackBucket)
    throw new Error("no TRACK_BUCKET (deploy/terraform track.tf output track_bucket)");
  return { bucket: s.trackBucket };
}

/** The gateway's free vision-capable Flash: cheap, sees the frames, and its keys cost nothing. */
export const LABEL_MODEL = "gemini/gemini-3.1-flash-lite";

/**
 * The labelling model: the LLM gateway when `WREN_LLM_GATEWAY_URL` and `WREN_LLM_GATEWAY_TOKEN`
 * are in the environment, else the configured provider. Null when neither is there.
 */
export function labelLlm(settings: Settings, env: NodeJS.ProcessEnv = process.env): Llm | null {
  const url = env.WREN_LLM_GATEWAY_URL;
  const apiKey = env.WREN_LLM_GATEWAY_TOKEN;
  if (url && apiKey)
    return openaiLlm({
      apiKey,
      model: env.AUTOTRACK_LABEL_MODEL || LABEL_MODEL,
      baseUrl: url,
      http: httpClient({ timeoutMs: 180_000 }),
    });
  return llmFor(settings);
}

function refOf(ref: string): { device: string; session: string } {
  const [device, session, ...rest] = ref.split("/");
  if (!device || !session || rest.length)
    throw new Error("give <device>/<session> (autobrowse autotrack list)");
  return { device, session };
}

export function registerAutotrackCommands(program: Command, settings: Settings): void {
  const track = program
    .command("autotrack")
    .description("autotrack: a device's recorded sessions (every input and screen), in a bucket");
  track
    .command("enroll <device>")
    .description(
      "Make a write-only key for a device (kebab-case name) and print its install code; again = a new key. --revoke removes it",
    )
    .option("--revoke", "delete the device's keys, policy and user")
    .action(async (device: string, o: { revoke?: boolean }) => {
      const { bucket } = operator(settings);
      const { iamClient } = await import("../autotrack/iam.js");
      const iam = iamClient(awsFor(settings));
      if (o.revoke) {
        console.log(
          (await revoke(iam, device)) ? `revoked ${device}` : `no device ${device} is enrolled`,
        );
        return;
      }
      const r = await enroll(iam, { bucket, region: settings.awsRegion, device });
      const cmds = installCommands(r.code);
      console.log(
        `enrolled ${device}${r.rotated ? ` (replaced ${r.rotated} old key${r.rotated > 1 ? "s" : ""})` : ""}`,
      );
      console.log(
        "The code below is a credential: it can write to this device's prefix, nothing else.",
      );
      console.log(`\ncode\n${r.code}\n\nWindows\n${cmds.windows}\n\nMac\n${cmds.mac}`);
    });
  track
    .command("devices")
    .description("Enrolled devices (IAM users under /track/)")
    .action(async () => {
      operator(settings);
      const { iamClient } = await import("../autotrack/iam.js");
      const rows = await devices(iamClient(awsFor(settings)));
      console.log(
        rows.length
          ? rows.map((d) => `${d.device}  ${d.created.slice(0, 10)}  keys ${d.keys}`).join("\n")
          : "no devices (autobrowse autotrack enroll <device>)",
      );
    });

  const store = async (): Promise<TrackWriter> => {
    const { bucket } = operator(settings);
    const { s3TrackStore } = await import("../autotrack/store.js");
    return s3TrackStore({ bucket, aws: awsFor(settings) });
  };
  track
    .command("list")
    .description(
      "Sessions in the bucket: device, session, segments, frames, trees, crops, OCR files, size, and the quality `steps` found",
    )
    .option("--device <device>", "only this device")
    .action(async (o: { device?: string }) => {
      const s = await store();
      const rows = await listSessions(s, o.device && checkDevice(o.device));
      const { readQualities, qualityLine } = await import("../autotrack/steps-run.js");
      const quality = await readQualities(s, rows);
      console.log(
        rows.length
          ? rows
              .map((r) => {
                const q = quality.get(`${r.device}/${r.session}`);
                return `${r.device}/${r.session}  segments ${r.segments}  frames ${r.frames}  trees ${r.trees}  crops ${r.crops}  ocr ${r.ocr}  ${size(r.bytes)}${q ? `  ${qualityLine(q)}` : ""}`;
              })
              .join("\n")
          : "no sessions",
      );
    });
  track
    .command("import <ref>")
    .description(
      "Turn <device>/<session> into a recording of desktop acts (teach and compile read it)",
    )
    .option("--name <name>", "recording name (default <device>-<session>)")
    .option("--site <site>", "recording site (default desktop)")
    .action(async (ref: string, o: { name?: string; site?: string }) => {
      const root = expandHome(settings.recordingsDir);
      const r = await importSession(await store(), refOf(ref), { root, ...o });
      console.log(
        `${r.name}: ${r.actions} actions from ${r.events} events, ${r.frames} frames, ${r.trees} trees, ${r.crops} crops, ${r.ocr} OCR files, ${r.stats} stats, in ${join(r.dir, "track")}\nnext: autobrowse compile ${r.name}`,
      );
    });
  track
    .command("label [ref]")
    .description(
      "Label a session offline: signals, episodes, goal/outcome and an intent per act, written to labels/<device>/<session>.json (and beside the import). --all: every session with no labels yet",
    )
    .option("--no-model", "rules only: signals and episodes, no model call")
    .option("--all", "every session with no labels yet")
    .option("--device <device>", "with --all: only this device")
    .action(
      async (ref: string | undefined, o: { model: boolean; all?: boolean; device?: string }) => {
        const { labelOne, unlabelled } = await import("../autotrack/label-run.js");
        const s = await store();
        const llm = o.model ? labelLlm(settings) : null;
        if (o.model && !llm)
          throw new Error("no model (gateway env or an LLM key); --no-model labels by rules only");
        const root = expandHome(settings.recordingsDir);
        if (!o.all && !ref) throw new Error("give <device>/<session> or --all");
        const refs = o.all
          ? (await unlabelled(s, o.device && checkDevice(o.device))).map((r) => ({
              device: r.device,
              session: r.session,
            }))
          : [refOf(ref as string)];
        if (o.all && !refs.length) console.log("every session already has labels");
        let failed = 0;
        for (const r of refs) {
          try {
            const out = await labelOne(s, r, { root, llm, log: (l) => console.log(l) });
            const t = out.stats;
            console.log(
              `${out.ref}: ${t.episodes} episodes, ${t.acts} acts, ${t.calls} calls (${t.cached} cached), ${t.inputTokens} in / ${t.outputTokens} out tokens, ${t.images} images, ${t.ms} ms${out.written ? `, written to ${labelKey(r.device, r.session)} and ${out.dir}` : ""}`,
            );
            for (const f of t.failed) console.log(`  ${f.episode} failed: ${f.error}`);
            if (!out.written) {
              failed++;
              console.log("  not written; rerun to retry (finished calls are cached)");
            }
          } catch (err) {
            failed++;
            console.log(
              `${r.device}/${r.session}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (failed) process.exitCode = 1;
      },
    );
  track
    .command("steps <ref> [session]")
    .description(
      "Build the RL view of a session: one line per act (screen before, action in frame pixels, screen after, tree diff, signals, intent, level), written to steps/<device>/<session>.jsonl.gz with a quality report beside it (and beside the import). <ref> is <device>/<session>, or a device with the session after it",
    )
    .option(
      "--min-quality <n>",
      "leave out episodes whose quality score (0 to 1) is lower; the report still lists them",
    )
    .action(async (ref: string, session: string | undefined, o: { minQuality?: string }) => {
      const min = o.minQuality === undefined ? undefined : Number(o.minQuality);
      if (min !== undefined && !(min >= 0 && min <= 1))
        throw new Error("--min-quality is a number from 0 to 1");
      const { stepsOne, stepsKey, qualityKey } = await import("../autotrack/steps-run.js");
      const r = refOf(session ? `${ref}/${session}` : ref);
      const out = await stepsOne(await store(), r, {
        root: expandHome(settings.recordingsDir),
        ...(min !== undefined ? { minQuality: min } : {}),
      });
      const { episodes, score } = out.report;
      const kept = episodes.filter((e) => e.kept).length;
      console.log(
        `${out.ref}: ${out.steps} steps, ${kept}/${episodes.length} episodes, quality ${score.toFixed(2)}, written to ${stepsKey(r.device, r.session)}, ${qualityKey(r.device, r.session)} and ${out.dir}`,
      );
      for (const e of episodes)
        console.log(
          `  ${e.id}  ${e.kept ? "kept" : "left out"}  quality ${e.score.toFixed(2)}  steps ${e.steps}${e.goal ? `  ${e.goal}` : ""}`,
        );
    });
}
