import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Iam } from "../src/autotrack/enroll.js";
import {
  checkHealth,
  type DeviceBeat,
  healthTransitions,
  readHealthState,
} from "../src/autotrack/health.js";
import {
  ago,
  type BeatRead,
  deviceLine,
  heartbeatKey,
  parseHeartbeat,
  problems,
  readHeartbeat,
} from "../src/autotrack/heartbeat.js";
import { listSessions, parseKey, type TrackStore } from "../src/autotrack/store.js";
import { fixtureStore } from "./autotrack-fixture.js";

const NOW = new Date("2026-10-15T12:00:00Z");
const full = {
  v: 1,
  version: "0.3.0",
  platform: "win32",
  arch: "x64",
  os: "Windows 11",
  at: "2026-10-15T11:48:00Z",
  startedAt: "2026-10-15T08:00:00Z",
  paused: null,
  level: "full",
  waiting: { segments: 1, bytes: 2_000_000 },
  ship: { at: "2026-10-15T11:45:00Z", ok: true, error: null },
  update: { checkedAt: "2026-10-15T09:00:00Z", latest: "0.3.0", state: "idle", error: null },
};
const ok = (o: object = {}): BeatRead => {
  const r = parseHeartbeat(JSON.stringify({ ...full, ...o }));
  if (r.kind !== "ok") throw new Error(JSON.stringify(r));
  return r;
};

/** S3's miss is an error named NoSuchKey. */
function store(objects: Record<string, string>): TrackStore {
  return {
    async list() {
      return [];
    },
    async get(key) {
      const b = objects[key];
      if (b === undefined) throw Object.assign(new Error(`${key}: missing`), { name: "NoSuchKey" });
      return Buffer.from(b);
    },
  };
}

describe("heartbeat reader", () => {
  it("reads a full beat and one with only v, version and at", () => {
    expect(ok().beat?.version).toBe("0.3.0");
    const r = parseHeartbeat(JSON.stringify({ v: 1, version: "0.2.9", at: full.at }));
    expect(r).toEqual({ kind: "ok", beat: { v: 1, version: "0.2.9", at: full.at } });
    expect(problems(r)).toEqual([]);
  });

  it("says why a body is not a heartbeat", () => {
    const bad = (b: string) => parseHeartbeat(b);
    expect(bad("{not json")).toMatchObject({ kind: "bad", beat: null, reason: /not JSON/ });
    expect(bad(JSON.stringify({ v: 1, at: full.at }))).toMatchObject({
      kind: "bad",
      reason: /version/,
    });
    expect(bad(JSON.stringify({ ...full, v: 2 }))).toMatchObject({ kind: "bad", reason: /^v:/ });
    expect(bad(JSON.stringify({ ...full, at: "yesterday" }))).toMatchObject({
      kind: "bad",
      reason: /at: not a date/,
    });
  });

  it("fetches through the store; a missing object is none, other errors throw", async () => {
    const s = store({ [heartbeatKey("pc")]: JSON.stringify(full), "bad/heartbeat.json": "x" });
    expect((await readHeartbeat(s, "pc")).kind).toBe("ok");
    expect(await readHeartbeat(s, "mac")).toEqual({ kind: "none", beat: null });
    expect((await readHeartbeat(s, "bad")).kind).toBe("bad");
    const broken: TrackStore = {
      list: async () => [],
      get: async () => {
        throw Object.assign(new Error("denied"), { name: "AccessDenied" });
      },
    };
    await expect(readHeartbeat(broken, "pc")).rejects.toThrow(/denied/);
  });

  it("is not a session key, so list leaves it out", async () => {
    expect(parseKey("test-mac/heartbeat.json")).toBeNull();
    const s = fixtureStore();
    const before = await listSessions(s);
    await s.put(heartbeatKey("test-mac"), Buffer.from(JSON.stringify(full)));
    expect(await listSessions(s)).toEqual(before);
  });
});

describe("devices formatting", () => {
  const d = { device: "william-pc", created: "2026-10-13T10:00:00Z", keys: 1 };

  it("reads relative time", () => {
    expect(ago(30_000)).toBe("now");
    expect(ago(12 * 60_000)).toBe("12m ago");
    expect(ago(5 * 3_600_000)).toBe("5h ago");
    expect(ago(80 * 3_600_000)).toBe("3d ago");
  });

  it("keeps the IAM columns, then version and last seen", () => {
    expect(deviceLine(d, ok(), NOW)).toBe("william-pc  2026-10-13  keys 1  v0.3.0  seen 12m ago");
    expect(deviceLine(d, { kind: "none", beat: null }, NOW)).toBe(
      "william-pc  2026-10-13  keys 1  v-  seen never",
    );
  });

  it("lists problems: paused, ship and update errors, a backlog, an unreadable beat", () => {
    const r = ok({
      paused: "hotkey",
      ship: { ok: false, error: "403 AccessDenied" },
      update: { error: "bad signature" },
      waiting: { segments: 14, bytes: 340_000_000 },
    });
    expect(problems(r)).toEqual([
      "paused (hotkey)",
      "ship error: 403 AccessDenied",
      "update error: bad signature",
      "waiting 14 segments (340 MB)",
    ]);
    expect(deviceLine(d, r, NOW)).toMatch(/seen 12m ago {2}paused \(hotkey\); ship error/);
    expect(problems(ok({ waiting: { segments: 2, bytes: 1.2e9 } }))).toEqual([
      "waiting 2 segments (1200 MB)",
    ]);
    expect(deviceLine(d, { kind: "bad", beat: null, reason: "not JSON" }, NOW)).toBe(
      "william-pc  2026-10-13  keys 1  v-  seen never  heartbeat unreadable (not JSON)",
    );
  });
});

describe("fleet health", () => {
  const row = (device: string, read: BeatRead, created = "2026-10-01T00:00:00Z"): DeviceBeat => ({
    device,
    created,
    read,
  });

  it("posts once on going silent, again on coming back", () => {
    const stale = ok({ at: "2026-10-14T09:12:00Z" });
    const a = healthTransitions({ silent: [] }, [row("william-pc", stale)], NOW);
    expect(a.transitions).toEqual([
      {
        device: "william-pc",
        silent: true,
        text: "autotrack: william-pc silent 26h (last 0.3.0 at 2026-10-14 09:12 UTC)",
      },
    ]);
    expect(a.next).toEqual({ silent: ["william-pc"] });
    // Still silent: no repeat.
    expect(healthTransitions(a.next, [row("william-pc", stale)], NOW).transitions).toEqual([]);
    const back = healthTransitions(a.next, [row("william-pc", ok({ version: "0.3.1" }))], NOW);
    expect(back.transitions.map((t) => t.text)).toEqual(["autotrack: william-pc back (0.3.1)"]);
    expect(back.next).toEqual({ silent: [] });
  });

  it("a device that never beat counts once it was enrolled over 24 h ago", () => {
    const none: BeatRead = { kind: "none", beat: null };
    const fresh = healthTransitions(
      { silent: [] },
      [row("new-pc", none, "2026-10-15T01:00:00Z")],
      NOW,
    );
    expect(fresh.transitions).toEqual([]);
    const old = healthTransitions(
      { silent: [] },
      [row("old-pc", none, "2026-10-12T08:00:00Z")],
      NOW,
    );
    expect(old.transitions.map((t) => t.text)).toEqual([
      "autotrack: old-pc silent, never beat (enrolled 2026-10-12)",
    ]);
  });

  it("an unreadable beat keeps the last state; a revoked device drops out", () => {
    const bad: BeatRead = { kind: "bad", beat: null, reason: "x" };
    const r = healthTransitions({ silent: ["a", "gone"] }, [row("a", bad), row("b", bad)], NOW);
    expect(r).toEqual({ next: { silent: ["a"] }, transitions: [] });
  });

  it("checkHealth posts, saves state, and retries a failed post next time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "track-health-"));
    const file = join(dir, "state", "autotrack-health.json");
    const iam = {
      listUsers: async () => [
        { name: "track-william-pc", created: "2026-10-01T00:00:00Z", keys: 1 },
        { name: "track-sister-pc", created: "2026-10-01T00:00:00Z", keys: 1 },
      ],
    } as unknown as Iam;
    const s = store({
      [heartbeatKey("william-pc")]: JSON.stringify({ ...full, at: "2026-10-13T00:00:00Z" }),
      [heartbeatKey("sister-pc")]: JSON.stringify(full),
    });
    const posts: string[] = [];
    let fail = true;
    const post = async (t: string) => {
      if (fail) throw new Error("HTTP 500");
      posts.push(t);
    };
    const warns: string[] = [];
    const run = () =>
      checkHealth({ iam, store: s, file, post, now: NOW, warn: (m) => warns.push(m) });
    expect(await run()).toEqual([]);
    expect(await readHealthState(file)).toEqual({ silent: [] });
    expect(warns[0]).toMatch(/william-pc: HTTP 500/);
    fail = false;
    expect((await run()).map((t) => t.device)).toEqual(["william-pc"]);
    expect(posts).toEqual([
      "autotrack: william-pc silent 60h (last 0.3.0 at 2026-10-13 00:00 UTC)",
    ]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ silent: ["william-pc"] });
    expect(await run()).toEqual([]);
    expect(posts).toHaveLength(1);
  });
});
