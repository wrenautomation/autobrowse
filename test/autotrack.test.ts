import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDevice,
  decodeCode,
  encodeCode,
  installCommands,
  type TrackCode,
} from "../src/autotrack/code.js";
import { devices, enroll, type Iam, putOnlyPolicy, revoke } from "../src/autotrack/enroll.js";
import { comboOf, importSession } from "../src/autotrack/import.js";
import { listSessions, parseKey } from "../src/autotrack/store.js";
import { loadRecording } from "../src/recorder/store.js";
import { bundledFixtureStore, fixtureStore, NEW, OLD } from "./autotrack-fixture.js";

const good: TrackCode = {
  v: 1,
  bucket: "autobrowse-prod-track-123456789012",
  region: "us-east-1",
  device: "test-mac",
  keyId: "AKIAIOSFODNN7EXAMPLE",
  secret: "abcdefghijklmnopqrstuvwxyz0123456789ABCD",
};

describe("install code", () => {
  it("round-trips as base64url JSON", () => {
    const code = encodeCode(good);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(code, "base64url").toString())).toEqual(good);
    expect(decodeCode(code)).toEqual(good);
    expect(decodeCode(`  ${code}\n`)).toEqual(good);
  });

  it("rejects bad input", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(() => decodeCode("")).toThrow();
    expect(() => decodeCode("not base64!")).toThrow(/install code/);
    expect(() => decodeCode(enc("a string"))).toThrow(/bad install code/);
    expect(() => decodeCode(Buffer.from("{nope").toString("base64url"))).toThrow(/JSON/);
    expect(() => decodeCode(enc({ ...good, v: 2 }))).toThrow(/v/);
    expect(() => decodeCode(enc({ ...good, device: "Test Mac" }))).toThrow(/device/);
    expect(() => decodeCode(enc({ ...good, keyId: "" }))).toThrow(/keyId/);
    expect(() => decodeCode(enc({ ...good, extra: 1 }))).toThrow();
    const { secret: _s, ...noSecret } = good;
    expect(() => decodeCode(enc(noSecret))).toThrow(/secret/);
    expect(() => encodeCode({ ...good, device: "a/b" })).toThrow();
  });

  it("fills both install lines", () => {
    const c = installCommands("CODE");
    expect(c.windows).toBe(
      `$env:AUTOTRACK='CODE'; irm https://raw.githubusercontent.com/wrenautomation/autotrack/main/install/install.ps1 | iex`,
    );
    expect(c.mac).toBe(
      `AUTOTRACK='CODE' sh -c "$(curl -fsSL https://raw.githubusercontent.com/wrenautomation/autotrack/main/install/install.sh)"`,
    );
  });
});

/** An in-memory IAM that logs every call. */
function fakeIam() {
  const log: string[] = [];
  const users = new Map<string, { path: string; policies: Map<string, string>; keys: string[] }>();
  let n = 0;
  const user = (name: string) => {
    const u = users.get(name);
    if (!u) throw new Error(`NoSuchEntity ${name}`);
    return u;
  };
  const iam: Iam = {
    async userExists(name) {
      return users.has(name);
    },
    async createUser(name, path) {
      log.push(`createUser ${name} ${path}`);
      users.set(name, { path, policies: new Map(), keys: [] });
    },
    async putUserPolicy(name, policy, doc) {
      log.push(`putUserPolicy ${name} ${policy}`);
      user(name).policies.set(policy, doc);
    },
    async listAccessKeys(name) {
      return [...user(name).keys];
    },
    async createAccessKey(name) {
      const u = user(name);
      if (u.keys.length >= 2) throw new Error("LimitExceeded");
      const keyId = `AKIAKEY${String(++n).padStart(13, "0")}`;
      log.push(`createAccessKey ${name}`);
      u.keys.push(keyId);
      return { keyId, secret: `secret${n}`.padEnd(40, "x") };
    },
    async deleteAccessKey(name, id) {
      log.push(`deleteAccessKey ${name} ${id}`);
      const u = user(name);
      u.keys = u.keys.filter((k) => k !== id);
    },
    async deleteUserPolicy(name, policy) {
      log.push(`deleteUserPolicy ${name} ${policy}`);
      user(name).policies.delete(policy);
    },
    async deleteUser(name) {
      log.push(`deleteUser ${name}`);
      const u = user(name);
      if (u.keys.length || u.policies.size) throw new Error("DeleteConflict");
      users.delete(name);
    },
    async listUsers(path) {
      return [...users]
        .filter(([, u]) => u.path === path)
        .map(([name, u]) => ({ name, created: "2026-10-13T00:00:00.000Z", keys: u.keys.length }));
    },
  };
  return { iam, log, users };
}

const where = { bucket: good.bucket, region: "us-east-1" };

describe("enroll", () => {
  it("scopes the policy to put on the device prefix and prints a decodable code", async () => {
    const { iam, log, users } = fakeIam();
    const r = await enroll(iam, { ...where, device: "test-mac" });
    expect(log).toEqual([
      "createUser track-test-mac /track/",
      "putUserPolicy track-test-mac track-put",
      "createAccessKey track-test-mac",
    ]);
    const policy = JSON.parse(users.get("track-test-mac")?.policies.get("track-put") ?? "");
    expect(policy).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: "s3:PutObject",
          Resource: `arn:aws:s3:::${good.bucket}/test-mac/*`,
        },
      ],
    });
    expect(putOnlyPolicy(good.bucket, "test-mac")).toBe(JSON.stringify(policy));
    expect(decodeCode(r.code)).toMatchObject({ ...where, device: "test-mac" });
    expect(decodeCode(r.code).keyId).toBe(users.get("track-test-mac")?.keys[0]);
  });

  it("re-enrolling deletes the old keys and makes a new one", async () => {
    const { iam, log, users } = fakeIam();
    const first = await enroll(iam, { ...where, device: "test-mac" });
    log.length = 0;
    const second = await enroll(iam, { ...where, device: "test-mac" });
    expect(second.rotated).toBe(1);
    expect(log).toEqual([
      "putUserPolicy track-test-mac track-put",
      `deleteAccessKey track-test-mac ${first.payload.keyId}`,
      "createAccessKey track-test-mac",
    ]);
    expect(users.get("track-test-mac")?.keys).toEqual([second.payload.keyId]);
    expect(second.payload.keyId).not.toBe(first.payload.keyId);
  });

  it("rejects device names that are not kebab-case", async () => {
    const { iam } = fakeIam();
    for (const d of ["Test Mac", "a/b", "-x", "x-", "a--b", "", "x".repeat(41), "../x"])
      await expect(enroll(iam, { ...where, device: d })).rejects.toThrow(/kebab-case/);
  });

  it("revoke deletes keys, then the policy, then the user", async () => {
    const { iam, log, users } = fakeIam();
    const r = await enroll(iam, { ...where, device: "test-mac" });
    log.length = 0;
    expect(await revoke(iam, "test-mac")).toBe(true);
    expect(log).toEqual([
      `deleteAccessKey track-test-mac ${r.payload.keyId}`,
      "deleteUserPolicy track-test-mac track-put",
      "deleteUser track-test-mac",
    ]);
    expect(users.size).toBe(0);
    expect(await revoke(iam, "test-mac")).toBe(false);
  });

  it("lists devices under /track/", async () => {
    const { iam } = fakeIam();
    await enroll(iam, { ...where, device: "test-mac" });
    await enroll(iam, { ...where, device: "sister-pc" });
    expect((await devices(iam)).map((d) => d.device).sort()).toEqual(["sister-pc", "test-mac"]);
  });
});

describe("track keys and sessions", () => {
  it("parses the bucket layout", () => {
    expect(parseKey("d/20261013T101500-ab12/session.json")).toMatchObject({ kind: "meta" });
    expect(parseKey("d/s/001/events.jsonl.gz")).toEqual({
      device: "d",
      session: "s",
      kind: "events",
      segment: "001",
    });
    expect(parseKey("d/s/000/frames/12.jpg")).toMatchObject({ kind: "frame", frame: 12 });
    expect(parseKey("d/s/000/frames/x.jpg")).toBeNull();
    expect(parseKey("d/s/000/trees/7.json.gz")).toMatchObject({
      kind: "tree",
      tree: 7,
      ext: "json",
    });
    expect(parseKey("d/s/000/trees/8.txt.gz")).toMatchObject({ kind: "tree", tree: 8, ext: "txt" });
    expect(parseKey("d/s/000/trees/8.txt")).toBeNull();
    expect(parseKey("d/s/000/other")).toBeNull();
  });

  it("parses crops, OCR and stats keys", () => {
    expect(parseKey("d/s/000/crops/4.jpg")).toEqual({
      device: "d",
      session: "s",
      kind: "crop",
      segment: "000",
      crop: 4,
    });
    expect(parseKey("d/s/000/ocr/12.json.gz")).toMatchObject({ kind: "ocr", of: "frame", n: 12 });
    expect(parseKey("d/s/000/ocr/c3.json.gz")).toMatchObject({ kind: "ocr", of: "crop", n: 3 });
    expect(parseKey("d/s/001/stats.json")).toEqual({
      device: "d",
      session: "s",
      kind: "stats",
      segment: "001",
    });
    // Not gzipped, or not a number: not ours.
    for (const k of [
      "d/s/000/crops/4.jpg.gz",
      "d/s/000/crops/x.jpg",
      "d/s/000/ocr/12.json",
      "d/s/000/ocr/cx.json.gz",
      "d/s/000/ocr/c.json.gz",
      "d/s/000/stats.json.gz",
      "d/s/000/x/stats.json",
    ])
      expect(parseKey(k), k).toBeNull();
  });

  it("leaves the labels and steps prefixes out of the session list", async () => {
    const store = fixtureStore();
    await store.put("labels/test-mac/20261013T111500-cd34.json", Buffer.from("{}"));
    await store.put("steps/test-mac/20261013T111500-cd34.jsonl.gz", Buffer.from("x"));
    await store.put("steps/test-mac/20261013T111500-cd34.quality.json", Buffer.from("{}"));
    expect((await listSessions(store)).map((r) => r.device)).toEqual(["test-mac", "test-mac"]);
    expect(() => checkDevice("steps")).toThrow(/prefix/);
    expect(() => checkDevice("labels")).toThrow(/prefix/);
  });

  it("lists sessions with segments, frames, crops, OCR files and size, newest first", async () => {
    const rows = await listSessions(fixtureStore());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ device: "test-mac", session: NEW.session, segments: 2 });
    expect(rows[0]).toMatchObject({ frames: 5, trees: 2, crops: 1, ocr: 3 });
    // The older recorder's session has none of the quality files, and still lists.
    expect(rows[1]).toMatchObject({
      device: "test-mac",
      session: OLD.session,
      segments: 2,
      frames: 1,
      trees: 2,
      crops: 0,
      ocr: 0,
    });
    expect(rows[1]?.bytes).toBeGreaterThan(0);
    expect(await listSessions(fixtureStore(), "other")).toEqual([]);
  });
});

/** Every file under `dir`, by path relative to it, with its bytes. */
const tree = (dir: string): Record<string, Buffer> =>
  Object.fromEntries(
    (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => statSync(join(dir, f)).isFile())
      .map((f) => [f, readFileSync(join(dir, f))]),
  );

describe("bundled segments (autotrack 0.4.0)", () => {
  it("list and read the same as one object per file", async () => {
    const store = bundledFixtureStore();
    expect([...store.raw.objects.keys()].some((k) => k.includes("/frames/"))).toBe(false);
    expect(await listSessions(store)).toEqual(await listSessions(fixtureStore()));
    for (const s of [OLD, NEW]) {
      const a = await importSession(fixtureStore(), s, {
        root: mkdtempSync(join(tmpdir(), "track-plain-")),
      });
      const b = await importSession(bundledFixtureStore(), s, {
        root: mkdtempSync(join(tmpdir(), "track-bundled-")),
      });
      expect({ ...b, dir: "" }).toEqual({ ...a, dir: "" });
      expect(tree(b.dir)).toEqual(tree(a.dir));
    }
  });

  it("reads a file it never listed from its segment's index", async () => {
    const plain = fixtureStore();
    const key = [...plain.objects.keys()].find((k) => k.includes("/frames/")) as string;
    const store = bundledFixtureStore();
    expect(await store.get(key)).toEqual(plain.objects.get(key));
    await expect(store.get(`${key}.missing`)).rejects.toThrow(/NoSuchKey/);
  });
});

describe("import", () => {
  it("combos", () => {
    expect(comboOf("4", ["meta", "shift"])).toBe("shift+cmd+4");
    expect(comboOf("a", ["ctrl"])).toBe("ctrl+a");
    expect(comboOf("enter", [])).toBe("enter");
  });

  it("turns the fixture session into a desktop recording", async () => {
    const root = mkdtempSync(join(tmpdir(), "track-import-"));
    const r = await importSession(
      fixtureStore(),
      { device: "test-mac", session: "20261013T101500-ab12" },
      { root },
    );
    expect(r).toMatchObject({
      name: "test-mac-20261013t101500-ab12",
      actions: 6,
      events: 10,
      frames: 1,
      trees: 2,
      crops: 0,
      ocr: 0,
      stats: 0,
    });
    const rec = await loadRecording(root, r.name);
    const shot = `${r.name}/track/frames/2.jpg`;
    expect(rec).toEqual({
      name: r.name,
      site: "desktop",
      startedAt: new Date(1791886500000).toISOString(),
      finishedAt: new Date(1791886560000).toISOString(),
      trace: null,
      terminal: null,
      commands: [],
      actions: [
        {
          kind: "desktop",
          t: 900,
          url: "",
          screenshot: shot,
          op: { op: "click", app: "Notes", role: "AXButton", name: "New Note" },
          redacted: false,
        },
        {
          kind: "desktop",
          t: 2000,
          url: "",
          screenshot: shot,
          op: { op: "type", text: "hello world" },
          redacted: false,
        },
        { kind: "note", t: 3000, url: "", text: "right click on (300, 400), no element in Notes" },
        {
          kind: "desktop",
          t: 4000,
          url: "",
          op: { op: "type", text: "<redacted>", secret: true },
          redacted: true,
        },
        {
          kind: "desktop",
          t: 5000,
          url: "",
          op: { op: "key", combo: "shift+cmd+4" },
          redacted: false,
        },
        // after-frame 5 is not in the bucket: no screenshot.
        { kind: "desktop", t: 5500, url: "", op: { op: "key", combo: "enter" }, redacted: false },
      ],
    });
    // The frame it points at came down, relative to the recordings root.
    expect(statSync(join(root, shot)).size).toBeGreaterThan(0);
    // Every tree came down, unzipped, under its own extension.
    const trees = join(r.dir, "track", "trees");
    expect(JSON.parse(readFileSync(join(trees, "3.json"), "utf8")).role).toBe("AXWindow");
    expect(readFileSync(join(trees, "4.txt"), "utf8")).toContain('button "New Note"');
  });

  it("pulls crops, OCR and stats next to frames and trees", async () => {
    const root = mkdtempSync(join(tmpdir(), "track-import-"));
    const r = await importSession(fixtureStore(), NEW, { root });
    expect(r).toMatchObject({ frames: 3, trees: 2, crops: 1, ocr: 3, stats: 2 });
    const track = join(r.dir, "track");
    // The crop is a JPEG as shipped.
    expect(
      readFileSync(join(track, "crops", "1.jpg"))
        .subarray(0, 2)
        .toString("hex"),
    ).toBe("ffd8");
    // OCR is unzipped: a frame's, a crop's (`c1`), and the `{same}` pointer as it was written.
    expect(JSON.parse(readFileSync(join(track, "ocr", "3.json"), "utf8")).lines[0].text).toBe(
      "New Note",
    );
    expect(JSON.parse(readFileSync(join(track, "ocr", "c1.json"), "utf8")).lines[0].w).toBe(120);
    expect(JSON.parse(readFileSync(join(track, "ocr", "4.json"), "utf8"))).toEqual({ same: 3 });
    // Stats come down per segment; trees, as before.
    expect(JSON.parse(readFileSync(join(track, "stats", "000.json"), "utf8")).crops).toBe(1);
    expect(JSON.parse(readFileSync(join(track, "stats", "001.json"), "utf8")).restarts).toEqual({
      probe: 1,
    });
    expect(JSON.parse(readFileSync(join(track, "trees", "6.json"), "utf8")).nodes).toHaveLength(4);
  });

  it("takes --name and --site, and refuses a bad session or an empty one", async () => {
    const root = mkdtempSync(join(tmpdir(), "track-import-"));
    const store = fixtureStore();
    const r = await importSession(
      store,
      { device: "test-mac", session: "20261013T101500-ab12" },
      { root, name: "notes-chore", site: "notes" },
    );
    expect((await loadRecording(root, r.name)).site).toBe("notes");
    await expect(
      importSession(store, { device: "test-mac", session: "nope" }, { root }),
    ).rejects.toThrow(/session id/);
    await expect(
      importSession(store, { device: "test-mac", session: "20260101T000000-0000" }, { root }),
    ).rejects.toThrow(/no segments/);
  });
});
