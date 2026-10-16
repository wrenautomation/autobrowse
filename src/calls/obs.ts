/**
 * OBS through its websocket (obs-websocket 5, `obs-websocket-js`): the only way the desk touches
 * it. A call records its own scene, `Wren call`: the main display and the Mac's sound, with
 * OBS's global mic. Starting saves the program scene and the mic's mute; stopping puts both
 * back, so his own video setup stays as it was. OBS opens minimised to the menu bar when it
 * isn't running (`open -g`), and quits after only if the desk opened it.
 */
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import OBSWebSocket from "obs-websocket-js";
import type { Booth } from "./recorder.js";
import { OBS_URL } from "./setup.js";

const run = promisify(execFile);

export const CALL_SCENE = "Wren call";
export const CALL_SCREEN = "Wren call screen";
export const CALL_AUDIO = "Wren call audio";

/** What a recording changed, to put back when it stops. */
export interface Saved {
  scene: string | null;
  mic: string | null;
  micMuted: boolean | null;
}

export type Obs = OBSWebSocket;

/** OBS's process is up. */
export async function obsRunning(): Promise<boolean> {
  return run("/usr/bin/pgrep", ["-x", "OBS"]).then(
    () => true,
    () => false,
  );
}

/**
 * A connected client. With `launch`, OBS is opened in the background first when it isn't
 * running (`launched` says so), then its websocket waited for up to `waitMs`.
 */
export async function connectObs(
  password: string,
  o: { launch?: boolean; waitMs?: number } = {},
): Promise<{ obs: Obs; launched: boolean }> {
  const obs = new OBSWebSocket();
  // Connected and past OBS's start-up: requests answer 207 "not ready" until its scenes load.
  const once = async () => {
    const up = await obs.connect(OBS_URL, password).then(
      () => true,
      () => false,
    );
    for (let i = 0; up && i < 30; i++) {
      const ready = await obs.call("GetSceneList").then(
        () => true,
        (err: { code?: number }) => {
          if (err.code !== 207) throw err;
          return false;
        },
      );
      if (ready) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  };
  if (await once()) return { obs, launched: false };
  if (!o.launch)
    throw new Error("OBS isn't running, or its websocket is off: autobrowse calls setup");
  let launched = false;
  if (!(await obsRunning())) {
    // In the background, minimised to the menu bar; no "safe mode" question after a crash.
    await run("/usr/bin/open", [
      ...["-g", "-a", "OBS", "--args", "--minimize-to-tray", "--disable-shutdown-check"],
    ]);
    launched = true;
  }
  const until = Date.now() + (o.waitMs ?? 25_000);
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await once()) return { obs, launched };
  }
  throw new Error("OBS's websocket didn't answer: is it on? autobrowse calls setup");
}

/** Quits OBS by an Apple event (no keys, no clicks); only when nothing records. */
export async function quitObs(obs: Obs): Promise<void> {
  const s = await obs.call("GetRecordStatus").catch(() => null);
  if (s?.outputActive) return;
  await obs.disconnect().catch(() => {});
  await run("/usr/bin/osascript", ["-e", 'tell application "OBS" to quit']).catch(() => {});
}

/** The `Wren call` scene and its two inputs, made once. */
export async function ensureScene(obs: Obs): Promise<void> {
  const { scenes } = await obs.call("GetSceneList");
  if (!scenes.some((s) => s.sceneName === CALL_SCENE))
    await obs.call("CreateScene", { sceneName: CALL_SCENE });
  const { inputs } = await obs.call("GetInputList");
  const has = (name: string) => inputs.some((i) => i.inputName === name);
  // ScreenCaptureKit: the main display (type 0), cursor shown; the Mac's own sound (type 0).
  if (!has(CALL_SCREEN))
    await obs.call("CreateInput", {
      sceneName: CALL_SCENE,
      inputName: CALL_SCREEN,
      inputKind: "screen_capture",
      inputSettings: { type: 0, show_cursor: true },
    });
  if (!has(CALL_AUDIO))
    await obs.call("CreateInput", {
      sceneName: CALL_SCENE,
      inputName: CALL_AUDIO,
      inputKind: "sck_audio_capture",
      inputSettings: { type: 0 },
    });
}

/**
 * The windows open now, as OBS lists them for a window capture: "[App] Title". OBS has Screen
 * Recording, so it reads titles a launchd process can't.
 */
export async function obsWindows(obs: Obs): Promise<string[]> {
  const { propertyItems } = await obs.call("GetInputPropertiesListPropertyItems", {
    inputName: CALL_SCREEN,
    propertyName: "window",
  });
  return propertyItems.map((i) => String(i.itemName ?? "")).filter(Boolean);
}

export async function recording(obs: Obs): Promise<boolean> {
  return (await obs.call("GetRecordStatus")).outputActive;
}

/** Switches to the call scene, unmutes the mic and records; what to put back after. */
export async function startCall(obs: Obs): Promise<Saved> {
  await ensureScene(obs);
  const { currentProgramSceneName } = await obs.call("GetCurrentProgramScene");
  const { mic1 } = await obs.call("GetSpecialInputs");
  const mic = mic1 ? String(mic1) : null;
  const micMuted = mic ? (await obs.call("GetInputMute", { inputName: mic })).inputMuted : null;
  const saved: Saved = { scene: currentProgramSceneName ?? null, mic, micMuted };
  await obs.call("SetCurrentProgramScene", { sceneName: CALL_SCENE });
  if (mic) await obs.call("SetInputMute", { inputName: mic, inputMuted: false });
  await obs.call("SetInputMute", { inputName: CALL_AUDIO, inputMuted: false });
  await obs.call("StartRecord");
  return saved;
}

/** Puts back what a start changed; each step on its own, so one gone input doesn't stop the rest. */
export async function restore(obs: Obs, saved: Saved): Promise<void> {
  if (saved.scene && saved.scene !== CALL_SCENE)
    await obs.call("SetCurrentProgramScene", { sceneName: saved.scene }).catch(() => {});
  if (saved.mic && saved.micMuted !== null)
    await obs
      .call("SetInputMute", { inputName: saved.mic, inputMuted: saved.micMuted })
      .catch(() => {});
}

/** Stops the recording; the file OBS wrote, or null when nothing was recording. */
export async function stopCall(obs: Obs, saved: Saved | null): Promise<string | null> {
  let path: string | null = null;
  if (await recording(obs)) path = (await obs.call("StopRecord")).outputPath ?? null;
  if (saved) await restore(obs, saved);
  return path;
}

/** The newest video in OBS's record folder written since `since`. */
export async function newestSince(obs: Obs, since: Date): Promise<string | null> {
  const { recordDirectory } = await obs.call("GetRecordDirectory");
  const names = await readdir(recordDirectory).catch(() => [] as string[]);
  let best: { file: string; at: number } | null = null;
  for (const n of names) {
    if (!/\.(mkv|mp4|mov|flv|ts|m4v)$/i.test(n)) continue;
    const file = join(recordDirectory, n);
    const s = await stat(file).catch(() => null);
    if (s?.isFile() && s.mtimeMs >= since.getTime() && (!best || s.mtimeMs > best.at))
      best = { file, at: s.mtimeMs };
  }
  return best?.file ?? null;
}

/**
 * OBS as the recorder's Booth: one connection, opened on first need (launching OBS minimised
 * if it isn't running) and let go when idle. OBS is quit after only if the desk opened it.
 */
export function obsBooth(password: () => Promise<string>): Booth {
  let conn: Promise<{ obs: Obs; launched: boolean }> | null = null;
  let launched = false;
  const get = async () => {
    if (!conn) {
      conn = connectObs(await password(), { launch: true }).then((c) => {
        launched ||= c.launched;
        c.obs.once("ConnectionClosed", () => {
          conn = null;
        });
        return c;
      });
      conn.catch(() => {
        conn = null;
      });
    }
    return (await conn).obs;
  };
  return {
    windows: async () => {
      const obs = await get();
      await ensureScene(obs);
      return obsWindows(obs);
    },
    recording: async () => recording(await get()),
    start: async () => startCall(await get()),
    stop: async (saved) => stopCall(await get(), saved),
    lastFile: async (since) => newestSince(await get(), since),
    idle: async () => {
      if (!conn) return;
      const { obs } = await conn;
      conn = null;
      if (launched) {
        launched = false;
        await quitObs(obs);
      } else await obs.disconnect().catch(() => {});
    },
  };
}
