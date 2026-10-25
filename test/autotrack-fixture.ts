/**
 * The bucket as `autotrack ship` lays it out, built from test/fixtures/track. Two sessions:
 * `20261013T101500-ab12` is an older recorder's (none of the quality fields) and
 * `20261013T111500-cd34` has crops, OCR, stats, `level` and `shot` events, two displays, and acts
 * with `path`, `settle` and `crop`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { bundled, type FilesIndex } from "../src/autotrack/store.js";
import { memoryStore } from "./autotrack-events.js";

export const FIXTURE = join(import.meta.dirname, "fixtures", "track");
export const OLD = { device: "test-mac", session: "20261013T101500-ab12" };
export const NEW = { device: "test-mac", session: "20261013T111500-cd34" };

/** Events, trees, OCR and stats ship gzipped (as `.gz`); frames and crops are JPEGs as they are. */
export function fixtureObjects(): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const key = relative(FIXTURE, p);
        const gz =
          f === "events.jsonl" ||
          (key.includes("/trees/") && /\.(json|txt)$/.test(f)) ||
          (key.includes("/ocr/") && f.endsWith(".json"));
        objects.set(gz ? `${key}.gz` : key, gz ? gzipSync(readFileSync(p)) : readFileSync(p));
      }
    }
  };
  walk(FIXTURE);
  return objects;
}

/** A writable in-memory bucket holding the fixtures: nothing here touches a real one. */
export const fixtureStore = () => memoryStore(fixtureObjects());

/**
 * The same bucket as autotrack 0.4.0 ships it: each segment's frames, crops, trees and OCR in one
 * `files.bin` with its `files.json`, read through `bundled`.
 */
export function bundledFixtureStore() {
  const objects = new Map<string, Buffer>();
  const segs = new Map<string, { index: FilesIndex; bodies: Buffer[]; at: number }>();
  for (const [key, body] of fixtureObjects()) {
    const p = key.split("/");
    if (p.length !== 5) {
      objects.set(key, body);
      continue;
    }
    const seg = p.slice(0, 3).join("/");
    const s = segs.get(seg) ?? { index: { v: 1 as const, files: [] }, bodies: [], at: 0 };
    s.index.files.push({ name: p.slice(3).join("/"), at: s.at, size: body.length });
    s.bodies.push(body);
    s.at += body.length;
    segs.set(seg, s);
  }
  for (const [seg, s] of segs) {
    objects.set(`${seg}/files.bin`, Buffer.concat(s.bodies));
    objects.set(`${seg}/files.json`, Buffer.from(JSON.stringify(s.index)));
  }
  const raw = memoryStore(objects);
  return Object.assign(bundled(raw), { raw });
}
