import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BlobStore,
  keepArtifact,
  keepRecording,
  shipShots,
  shipWording,
} from "../src/shots/ship.js";

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "shots-"));
  const artifacts = join(root, "artifacts");
  const recordings = join(root, "recordings");
  mkdirSync(artifacts);
  mkdirSync(join(recordings, "npm-token", "screenshots"), { recursive: true });
  writeFileSync(join(artifacts, "npm-login-1.png"), "png");
  writeFileSync(join(artifacts, "npm-login-1.aria.txt"), "aria");
  writeFileSync(join(artifacts, "npm-login-1.failure.json"), "{}");
  writeFileSync(join(artifacts, "npm-login-1.zip"), "trace with network bodies");
  writeFileSync(join(artifacts, "llm-budget.json"), "{}");
  writeFileSync(join(recordings, "npm-token", "manifest.json"), "{}");
  writeFileSync(join(recordings, "npm-token", "screenshots", "0000.png"), "png");
  return { root, artifacts, recordings, ledgerFile: join(root, "shots-shipped.tsv") };
}

function memoryStore(failAfter = Number.POSITIVE_INFINITY) {
  const put: Record<string, string> = {};
  const store: BlobStore = {
    async put(key, body, type) {
      if (Object.keys(put).length >= failAfter) throw new Error("AccessDenied");
      put[key] = `${type} ${Buffer.from(body).toString()}`;
    },
  };
  return { put, store };
}

const opts = (d: ReturnType<typeof dirs>, store: BlobStore) => ({
  roots: [
    { name: "artifacts", dir: d.artifacts, keep: keepArtifact },
    { name: "recordings", dir: d.recordings, keep: keepRecording },
  ],
  store,
  ledgerFile: d.ledgerFile,
  machine: "box",
});

describe("shipShots", () => {
  it("ships shots and the text that explains them; never traces or other state", async () => {
    const d = dirs();
    const { put, store } = memoryStore();
    const r = await shipShots(opts(d, store));
    expect(Object.keys(put).sort()).toEqual([
      "box/artifacts/npm-login-1.aria.txt",
      "box/artifacts/npm-login-1.failure.json",
      "box/artifacts/npm-login-1.png",
      "box/recordings/npm-token/manifest.json",
      "box/recordings/npm-token/screenshots/0000.png",
    ]);
    expect(put["box/artifacts/npm-login-1.png"]).toBe("image/png png");
    expect(r).toMatchObject({ shipped: 5, pending: 0, refused: null });
    // Nothing new: nothing ships. A rewritten manifest ships again.
    expect((await shipShots(opts(d, store))).shipped).toBe(0);
    const manifest = join(d.recordings, "npm-token", "manifest.json");
    writeFileSync(manifest, '{"steps":2}');
    utimesSync(manifest, new Date(), new Date(Date.now() + 5_000));
    expect((await shipShots(opts(d, store))).shipped).toBe(1);
  });

  it("a refusing store stops the run; the next run ships only what is left", async () => {
    const d = dirs();
    const first = memoryStore(2);
    const r = await shipShots(opts(d, first.store));
    expect(r).toMatchObject({ shipped: 2, pending: 3, refused: "AccessDenied" });
    expect(readFileSync(d.ledgerFile, "utf8").trim().split("\n")).toHaveLength(2);
    expect(shipWording(r, "shots")).toEqual([
      "shipped 2 files (0.0 MB) to shots",
      "shots refused: AccessDenied; 3 left, shipped next run",
    ]);
    const second = memoryStore();
    expect((await shipShots(opts(d, second.store))).shipped).toBe(3);
    expect(Object.keys(second.put)).toHaveLength(3);
  });

  it("dry counts and ships nothing", async () => {
    const d = dirs();
    const { put, store } = memoryStore();
    expect(await shipShots({ ...opts(d, store), dry: true })).toMatchObject({
      shipped: 0,
      pending: 5,
    });
    expect(put).toEqual({});
  });
});
