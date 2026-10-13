/**
 * `autobrowse autotrack …`: the storage side of autotrack (autotrack repo designs/2026-10-13-autotrack.md). `enroll` makes
 * a write-only key for one device and prints its install code; `list` and `import` read sessions
 * back and turn one into a recording teach can read.
 */
import { join } from "node:path";
import type { Command } from "commander";
import { checkDevice, installCommands } from "../autotrack/code.js";
import { devices, enroll, revoke } from "../autotrack/enroll.js";
import { importSession } from "../autotrack/import.js";
import { listSessions, type TrackStore } from "../autotrack/store.js";
import { expandHome } from "../google-auth.js";
import { isDefaultOwner } from "../owner.js";
import type { Settings } from "./config.js";
import { awsFor } from "./owner.js";

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

  const store = async (): Promise<TrackStore> => {
    const { bucket } = operator(settings);
    const { s3TrackStore } = await import("../autotrack/store.js");
    return s3TrackStore({ bucket, aws: awsFor(settings) });
  };
  track
    .command("list")
    .description("Sessions in the bucket: device, session, segments, frames, size")
    .option("--device <device>", "only this device")
    .action(async (o: { device?: string }) => {
      const rows = await listSessions(await store(), o.device && checkDevice(o.device));
      console.log(
        rows.length
          ? rows
              .map(
                (r) =>
                  `${r.device}/${r.session}  segments ${r.segments}  frames ${r.frames}  ${size(r.bytes)}`,
              )
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
      const [device, session, ...rest] = ref.split("/");
      if (!device || !session || rest.length)
        throw new Error("give <device>/<session> (autobrowse autotrack list)");
      const root = expandHome(settings.recordingsDir);
      const r = await importSession(await store(), { device, session }, { root, ...o });
      console.log(
        `${r.name}: ${r.actions} actions from ${r.events} events, ${r.frames} frames, in ${join(r.dir, "track")}\nnext: autobrowse compile ${r.name}`,
      );
    });
}
