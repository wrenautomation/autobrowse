import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  backupTraces,
  dirTraceStore,
  sweepTraces,
  type TraceStore,
  traceDirName,
} from "../src/shots/traces.js";

const DAY = 86_400_000;
const now = new Date("2026-10-24T00:00:00Z");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "traces-"));
  const own = join(root, "artifacts");
  const other = join(root, "internships", "artifacts");
  mkdirSync(join(own, "x-run"), { recursive: true });
  mkdirSync(other, { recursive: true });
  const old = new Date(now.getTime() - 20 * DAY);
  for (const [p, when] of [
    [join(own, "a.zip"), old],
    [join(own, "x-run", "trace.zip"), old],
    [join(other, "b.zip"), new Date(now.getTime() - DAY)],
  ] as const) {
    writeFileSync(p, `trace ${p}`);
    utimesSync(p, when, when);
  }
  writeFileSync(join(own, "a.png"), "png");
  return {
    root,
    paths: { a: join(own, "a.zip"), run: join(own, "x-run", "trace.zip"), b: join(other, "b.zip") },
    opts: {
      dirs: [
        { name: traceDirName(own, true), dir: own },
        { name: traceDirName(other, false), dir: other },
      ],
      ledgerFile: join(root, "traces-kept.tsv"),
      prefix: "traces/mac/",
    },
  };
}

describe("traces", () => {
  it("keeps every zip, one folder down too, and never a non-trace", async () => {
    const { root, opts } = setup();
    const store = dirTraceStore(join(root, "backup"));
    const r = await backupTraces({ ...opts, store });
    expect(r.shipped).toBe(3);
    expect(existsSync(join(root, "backup/traces/mac/artifacts/a.zip"))).toBe(true);
    expect(existsSync(join(root, "backup/traces/mac/artifacts/x-run/trace.zip"))).toBe(true);
    expect(existsSync(join(root, "backup/traces/mac/internships-artifacts/b.zip"))).toBe(true);
    expect(existsSync(join(root, "backup/traces/mac/artifacts/a.png"))).toBe(false);
    expect((await backupTraces({ ...opts, store })).shipped).toBe(0);
  });

  it("sweeps only old traces the ledger shows kept", async () => {
    const { root, opts, paths } = setup();
    expect(await sweepTraces({ ...opts, keepDays: 14, now })).toEqual({
      removed: 0,
      bytes: 0,
      unkept: 2,
    });
    expect(existsSync(paths.a)).toBe(true);
    await backupTraces({ ...opts, store: dirTraceStore(join(root, "backup")) });
    const dry = await sweepTraces({ ...opts, keepDays: 14, now, dry: true });
    expect(dry.removed).toBe(2);
    expect(existsSync(paths.a)).toBe(true);
    const r = await sweepTraces({ ...opts, keepDays: 14, now });
    expect(r).toMatchObject({ removed: 2, unkept: 0 });
    expect(existsSync(paths.a)).toBe(false);
    expect(existsSync(paths.run)).toBe(false);
    expect(existsSync(paths.b)).toBe(true);
  });

  it("keeps a trace that changed after its copy", async () => {
    const { root, opts, paths } = setup();
    await backupTraces({ ...opts, store: dirTraceStore(join(root, "backup")) });
    writeFileSync(paths.a, "a longer trace than before");
    const old = new Date(now.getTime() - 20 * DAY);
    utimesSync(paths.a, old, old);
    const r = await sweepTraces({ ...opts, keepDays: 14, now });
    expect(r).toMatchObject({ removed: 1, unkept: 1 });
    expect(existsSync(paths.a)).toBe(true);
  });

  it("stops at the first refusal and resumes after it", async () => {
    const { opts } = setup();
    let calls = 0;
    const refusing: TraceStore = {
      where: "s3://b/",
      async putFile() {
        if (++calls > 1) throw new Error("AccessDenied");
      },
      async *keys() {},
      async getFile() {},
    };
    const r = await backupTraces({ ...opts, store: refusing });
    expect(r).toMatchObject({ shipped: 1, pending: 2, refused: "AccessDenied" });
    expect(readFileSync(opts.ledgerFile, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
