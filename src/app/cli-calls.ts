/**
 * `autobrowse calls …`: William's calls recorded by OBS (wren designs/2026-10-16-call-recording.md).
 * `setup` turns on OBS's websocket by its config file (OBS closed) and keeps the password as the
 * `obs` credential, never printed. `start` / `stop` are Record now and Stop for an unbooked call;
 * the desk picks the recording up from the shared state file and handles the rest.
 */
import type { Command } from "commander";
import { obsBooth, obsRunning } from "../calls/obs.js";
import { Recorder } from "../calls/recorder.js";
import { macBanner } from "../calls/service.js";
import { enableWebsocket, OBS_CREDENTIAL } from "../calls/setup.js";
import type { Settings } from "./config.js";
import { credentialsFor } from "./services.js";

function recorderFor(settings: Settings): Recorder {
  return new Recorder({
    booth: obsBooth(async () => {
      const cred = await credentialsFor(settings).get(OBS_CREDENTIAL);
      if (!cred?.password) throw new Error("no OBS password: autobrowse calls setup");
      return cred.password;
    }),
    // Only the desk runs `wren calls`; the CLI never drains the queue.
    wren: async () => {
      throw new Error("the desk runs wren calls");
    },
    log: (msg) => console.error(msg),
    notify: macBanner,
  });
}

export function registerCallsCommands(program: Command, settings: Settings): void {
  const calls = program
    .command("calls")
    .description("William's calls recorded by OBS on this Mac: notes and transcript land in wren");

  calls
    .command("setup")
    .description("Turn on OBS's websocket (OBS must be closed) and store its password as `obs`")
    .action(async () => {
      if (await obsRunning())
        throw new Error("Quit OBS first: it writes its websocket config back when it quits");
      const store = credentialsFor(settings);
      const had = await store.get(OBS_CREDENTIAL);
      const { password, changed } = await enableWebsocket();
      if (!had || had.password !== password)
        await store.put(OBS_CREDENTIAL, {
          username: "obs-websocket",
          password,
          url: "ws://127.0.0.1:4455",
        });
      console.log(
        `${changed ? "websocket on" : "websocket already on"}; password ${had?.password === password ? "unchanged" : "stored"} as \`${OBS_CREDENTIAL}\``,
      );
    });

  const print = (s: Awaited<ReturnType<Recorder["status"]>>) =>
    console.log(
      s.recording
        ? `recording since ${s.since} (${s.by}${s.booking ? `, booking ${s.booking}` : ""})`
        : "not recording",
    );

  calls
    .command("status")
    .description("Recording or not")
    .action(async () => print(await recorderFor(settings).status()));

  calls
    .command("start")
    .description("Record now (opens OBS in the background if it isn't running)")
    .action(async () => {
      print(await recorderFor(settings).start());
      process.exit(0);
    });

  calls
    .command("stop")
    .description("Stop recording; the desk transcribes and files it")
    .action(async () => {
      print(await recorderFor(settings).stop());
      process.exit(0);
    });
}
