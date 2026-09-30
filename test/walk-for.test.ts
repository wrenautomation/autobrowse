import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Settings } from "../src/app/config.js";
import { walkFor, walksDirFor } from "../src/app/services.js";
import type { SecretSink } from "../src/deps/sink.js";
import { saveWalk, type WalkSpec } from "../src/walks/spec.js";

/** Only what walkFor reaches; a non-default owner keeps the operator's phone lines out. */
const settingsIn = (dir: string) =>
  ({
    credentialsCipher: "none",
    credentialsFile: join(dir, "credentials.json"),
    owner: "acme",
  }) as unknown as Settings;

const sink: SecretSink = { put: async () => {} };

const spec: WalkSpec = {
  version: 1,
  site: "scratch",
  name: "join-list",
  goal: "join the list",
  built: "2026-09-30T12:00:00.000Z",
  from: [],
  start: "https://site.test/signup",
  fields: [],
  secrets: [],
  irreversible: false,
  screens: [
    {
      name: "done",
      looks: "done",
      url: "site.test/welcome",
      landmarks: [],
      ops: [],
      goal: true,
      seen: 1,
    },
  ],
};

describe("walkFor", () => {
  it("finds a saved walk by <site>/walk-<name>, with or without an account", () => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-walk-for-"));
    const settings = settingsIn(dir);
    expect(walksDirFor(settings)).toBe(join(dir, "walks"));
    saveWalk(walksDirFor(settings), spec);
    for (const name of ["scratch/walk-join-list", "scratch@ops/walk-join-list"]) {
      const flow = walkFor(settings, name, sink);
      expect(flow?.name, name).toBe("walk-join-list");
      expect(flow?.site).toBe("scratch");
    }
    saveWalk(walksDirFor(settings), { ...spec, site: "google", name: "x" });
    expect(walkFor(settings, "google@ops/walk-x", sink)?.name).toBe("walk-x");
  });

  it("is null for a name that is not a walk, or a walk that is not saved", () => {
    const settings = settingsIn(mkdtempSync(join(tmpdir(), "autobrowse-walk-for-")));
    for (const name of [
      "scratch/join-list",
      "scratch/walk-",
      "scratch/walk-1x",
      "scratch/walk-join_list",
      "../x/walk-join-list",
      "scratch/sub/walk-join-list",
      "walk-join-list",
      "scratch@/walk-join-list",
    ])
      expect(walkFor(settings, name, sink), name).toBeNull();
    // Shaped right, nothing saved.
    expect(walkFor(settings, "scratch/walk-join-list", sink)).toBeNull();
    expect(walkFor(settings, "google@ops/walk-x", sink)).toBeNull();
  });
});
