/**
 * The bucket as `autotrack ship` lays it out, built from test/fixtures/track. Two sessions:
 * `20261013T101500-ab12` is an older recorder's (none of the quality fields) and
 * `20261013T111500-cd34` has crops, OCR, stats, `level` and `shot` events, two displays, and acts
 * with `path`, `settle` and `crop`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
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
