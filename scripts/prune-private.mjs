// The package leaves out flows marked `.private` in src/workflows: their defaults name a real
// person or account (src/workflows/roots.ts PRIVATE_MARK).
import { existsSync, readdirSync, rmSync } from "node:fs";

const src = new URL("../src/workflows/", import.meta.url);
const dist = new URL("../dist/workflows/", import.meta.url);
const pruned = readdirSync(src, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/.private`, src)))
  .map((d) => d.name);
for (const name of pruned) rmSync(new URL(`${name}/`, dist), { recursive: true, force: true });
console.log(`private flows left out: ${pruned.length}`);
