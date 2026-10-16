import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Saved } from "./obs.js";
import { BANNER, type Booth, Recorder, type RecorderFile } from "./recorder.js";
import { enabledConfig } from "./setup.js";
import { callWindow } from "./windows.js";

const MEET = "[Google Chrome] Meet - abc-defg-hij";

/** OBS as a script: windows open now, a recording that writes `out/<n>.mkv`. */
async function rig() {
  const dir = await mkdtemp(join(tmpdir(), "calls-"));
  let clock = new Date("2026-10-16T13:50:00Z");
  const said: string[] = [];
  const banners: string[] = [];
  const adds: string[][] = [];
  const booth = {
    windows: [] as string[],
    recording: false,
    starts: 0,
    restored: [] as (Saved | null)[],
    n: 0,
  };
  const saved: Saved = { scene: "Scene", mic: "Mic/Aux", micMuted: true };
  const fake: Booth = {
    windows: async () => booth.windows,
    recording: async () => booth.recording,
    start: async () => {
      booth.recording = true;
      booth.starts++;
      return saved;
    },
    stop: async (s) => {
      booth.restored.push(s);
      if (!booth.recording) return null;
      booth.recording = false;
      const f = join(dir, `${++booth.n}.mkv`);
      await writeFile(f, "x");
      return f;
    },
    lastFile: async () => {
      const f = join(dir, `${++booth.n}.mkv`);
      await writeFile(f, "x");
      return f;
    },
    idle: async () => {},
  };
  let wrenFails: string | null = null;
  const r = new Recorder({
    booth: fake,
    wren: async (args) => {
      if (args[1] === "upcoming")
        return JSON.stringify([
          { id: 7, start: "2026-10-16T14:00:00Z", end: "2026-10-16T14:30:00Z", who: "Sam" },
        ]);
      adds.push(args);
      if (wrenFails) throw new Error(wrenFails);
      return '{"id":1}';
    },
    log: (m) => said.push(m),
    notify: async (m) => {
      banners.push(m);
    },
    now: () => clock,
    path: join(dir, "state.json"),
    dir: join(dir, "calls"),
  });
  const at = (iso: string) => {
    clock = new Date(iso);
  };
  const file = async () =>
    JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as RecorderFile;
  return {
    r,
    booth,
    at,
    file,
    said,
    banners,
    adds,
    fail: (m: string | null) => {
      wrenFails = m;
    },
  };
}

describe("call windows", () => {
  it("knows Meet, Zoom and Teams calls, and nothing else", () => {
    expect(callWindow(["[Finder] Downloads", MEET])).toBe(MEET);
    expect(callWindow(["[Safari] Google Meet"])).toBe("[Safari] Google Meet");
    expect(callWindow(["[zoom.us] Zoom Meeting"])).toBe("[zoom.us] Zoom Meeting");
    expect(callWindow(["[Microsoft Teams] Meeting with Sam"])).not.toBeNull();
    expect(callWindow(["[Code] meeting.md", "[Google Chrome] Meet the team - blog"])).toBeNull();
  });
});

describe("websocket config", () => {
  it("turns the server on and keeps a password already set", () => {
    const c = enabledConfig({ server_enabled: false, server_password: "kept", extra: 1 });
    expect(c).toMatchObject({ server_enabled: true, auth_required: true, server_port: 4455 });
    expect(c.server_password).toBe("kept");
    expect(c.extra).toBe(1);
    expect(enabledConfig({}, () => "made").server_password).toBe("made");
  });
});

describe("the recorder", () => {
  it("waits for the call window, records, and stops 3 min after it closes", async () => {
    const t = await rig();
    await t.r.tick(); // 13:50: not due yet
    expect(t.booth.starts).toBe(0);
    t.at("2026-10-16T13:56:00Z");
    await t.r.tick(); // due, but no call window
    expect(t.booth.starts).toBe(0);
    t.booth.windows = [MEET];
    await t.r.tick();
    expect(t.booth.starts).toBe(1);
    expect(t.banners).toEqual([BANNER]);
    expect((await t.file()).live).toMatchObject({ booking: 7, by: "desk" });
    t.booth.windows = [];
    t.at("2026-10-16T14:20:00Z");
    await t.r.tick(); // gone 24 min after last seen at 13:56
    expect(t.adds).toEqual([]); // OBS still finishing the file
    t.at("2026-10-16T14:21:01Z");
    await t.r.drain();
    const f = await t.file();
    expect(f.live).toBeNull();
    expect(f.done).toEqual([7]);
    expect(t.booth.restored[0]).toMatchObject({ scene: "Scene", micMuted: true });
    // The finished file was moved and handed to wren once.
    expect(t.adds[0]?.slice(0, 2)).toEqual(["calls", "add"]);
    expect(t.adds[0]?.[2]).toContain("/calls/");
    expect(t.adds[0]).toEqual(expect.arrayContaining(["--booking", "7", "--by", "desk"]));
    expect((await t.file()).queue).toEqual([]);
    // Not armed again for the same call.
    t.booth.windows = [MEET];
    await t.r.tick();
    expect(t.booth.starts).toBe(1);
  });

  it("picks up a stop by hand in OBS", async () => {
    const t = await rig();
    t.at("2026-10-16T14:01:00Z");
    t.booth.windows = [MEET];
    await t.r.tick();
    t.booth.recording = false; // William pressed Stop in OBS
    await t.r.tick();
    t.at("2026-10-16T14:02:01Z");
    await t.r.drain();
    const f = await t.file();
    expect(f.live).toBeNull();
    expect(t.adds).toHaveLength(1);
  });

  it("records now and stops on Stop, linked to the call in its window", async () => {
    const t = await rig();
    await t.r.tick(); // learns the upcoming call
    t.at("2026-10-16T14:05:00Z");
    const s = await t.r.start();
    expect(s).toMatchObject({ recording: true, by: "manual", booking: 7 });
    expect(await t.r.start()).toMatchObject({ recording: true });
    expect(t.booth.starts).toBe(1);
    expect(await t.r.stop()).toMatchObject({ recording: false });
    expect((await t.file()).queue).toHaveLength(1);
  });

  it("keeps files queued while wren lacks the command, and gives up after 3 tries", async () => {
    const t = await rig();
    t.at("2026-10-16T14:05:00Z");
    await t.r.start();
    t.fail("exit 1: error: unknown command 'calls'");
    await t.r.stop();
    t.at("2026-10-16T14:06:00Z");
    await t.r.drain();
    expect(t.adds).toHaveLength(1);
    expect((await t.file()).queue[0]?.tries).toBe(0);
    t.fail("exit 1: transcribe broke");
    for (const m of ["07", "20", "45"]) {
      t.at(`2026-10-16T14:${m}:00Z`);
      await t.r.drain();
    }
    expect((await t.file()).queue).toEqual([]);
    expect(t.banners.at(-1)).toMatch(/didn't save/);
  });
});
