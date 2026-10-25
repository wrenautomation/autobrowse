import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { holdsSecret, secret } from "../src/browser/secrets.js";
import { SECRET_MARK, scrubSecrets, scrubSecretsFile } from "../src/browser/trace-secrets.js";
import { scrubKeptTraces } from "../src/shots/trace-scrub.js";
import { dirTraceStore } from "../src/shots/traces.js";

const PASSWORD = "Tr0ub4dor&3x";
const USER = "someone@example.org";
const ndjson = (rows: object[]) => strToU8(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

let n = 0;
const call = (method: string, params: object) => ({
  type: "before",
  callId: `c${++n}`,
  method,
  params,
});

/** A sign-in as Hands types it: one key per call, a slip and its Backspace, pauses between. */
function fixture() {
  n = 0;
  const keys = (text: string, slipAt = -1) =>
    [...text].flatMap((ch, i) => [
      ...(i === slipAt
        ? [call("keyboardType", { text: "q" }), call("keyboardPress", { key: "Backspace" })]
        : []),
      call("keyboardType", { text: ch }),
      call("waitForTimeout", { timeout: 80 }),
    ]);
  const field = (value: string, type: string) => ({
    type: "frame-snapshot",
    snapshot: { html: ["HTML", {}, ["BODY", {}, ["INPUT", { type, __playwright_value_: value }]]] },
  });
  const trace = [
    call("click", { selector: "#user" }),
    ...keys(USER),
    field(USER, "email"),
    call("click", { selector: "#pass" }),
    ...keys(PASSWORD, 4),
    field(PASSWORD.slice(0, 3), "password"),
    field(PASSWORD.slice(0, 7), "password"),
    field(PASSWORD, "password"),
    call("keyboardPress", { key: "Enter" }),
    { type: "log", callId: "c99", message: "unrelated" },
    { type: "after", callId: "c100", result: { value: PASSWORD } },
  ];
  const body = `email=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASSWORD)}`;
  const network = [
    {
      type: "resource-snapshot",
      snapshot: {
        request: {
          url: "https://example.org/login",
          headers: [
            { name: "Cookie", value: "sid=abc123" },
            { name: "Accept", value: "text/html" },
          ],
          postData: { mimeType: "application/x-www-form-urlencoded", _file: "aa.txt" },
        },
        response: { cookies: [{ name: "sid", value: "def456" }], headers: [] },
      },
    },
  ];
  return zipSync({
    "trace.trace": ndjson(trace),
    "trace.network": ndjson(network),
    "resources/aa.txt": strToU8(body),
    "resources/frame.jpeg": new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x81]),
  });
}

/** Every entry of a zip on disk as text: a compressed zip never shows its contents raw. */
const unzipped = async (path: string) =>
  Object.values(unzipSync(await readFile(path)))
    .map((b) => strFromU8(b))
    .join("\n");

const typed = (files: Record<string, Uint8Array>) =>
  strFromU8(files["trace.trace"] as Uint8Array)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.method === "keyboardType")
    .map((e) => e.params.text)
    .join("");

describe("scrubSecrets", () => {
  it("masks a secret field's value, its typed keys and its encoded body, keeps the rest", () => {
    const { zip, report } = scrubSecrets(fixture(), []);
    expect(zip).not.toBeNull();
    const files = unzipSync(zip as Uint8Array);
    const all = Object.values(files)
      .map((b) => strFromU8(b))
      .join("\n");
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(encodeURIComponent(PASSWORD));
    expect(all).not.toContain(PASSWORD.slice(0, 7));
    expect(report.found).toBe(3);
    expect(report.leaks).toBe(0);
    // The username was typed too, and is no secret: it stays, key for key.
    expect(typed(files).startsWith(USER)).toBe(true);
    expect(typed(files)).not.toMatch(/q/);
    expect(strFromU8(files["resources/aa.txt"] as Uint8Array)).toBe(
      `email=${encodeURIComponent(USER)}&password=${SECRET_MARK}`,
    );
    const net = strFromU8(files["trace.network"] as Uint8Array);
    expect(net).not.toContain("abc123");
    expect(net).not.toContain("def456");
    expect(net).toContain("text/html");
    expect(files["resources/frame.jpeg"]).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x81]));
  });

  it("starts from a trace that holds the password", () => {
    const all = Object.values(unzipSync(fixture()))
      .map((b) => strFromU8(b))
      .join("\n");
    expect(all).toContain(PASSWORD.slice(0, 7));
    expect(all).toContain(encodeURIComponent(PASSWORD));
  });

  it("is idempotent: a scrubbed trace comes back unchanged", () => {
    const once = scrubSecrets(fixture(), []).zip as Uint8Array;
    expect(scrubSecrets(once, []).zip).toBeNull();
  });

  it("masks a held secret typed into a field that is no password field", () => {
    n = 0;
    const zip = zipSync({
      "trace.trace": ndjson([...[..."482913"].map((ch) => call("keyboardType", { text: ch }))]),
    });
    expect(scrubSecrets(zip, []).zip).toBeNull();
    const files = unzipSync(scrubSecrets(zip, ["482913"]).zip as Uint8Array);
    expect(typed(files)).toBe(SECRET_MARK.repeat(6));
  });
});

describe("scrubSecretsFile", () => {
  let dir = "";
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("rewrites in place and keeps the mtime", async () => {
    dir = await mkdtemp(join(tmpdir(), "trace-secrets-"));
    const path = join(dir, "t.zip");
    await writeFile(path, fixture());
    const before = await stat(path);
    const report = await scrubSecretsFile(path, []);
    expect(report.changed).toBe(true);
    expect(await unzipped(path)).not.toContain(PASSWORD);
    expect(Math.abs((await stat(path)).mtimeMs - before.mtimeMs)).toBeLessThan(1);
  });
});

describe("secrets", () => {
  it("holds a secret and matches it inside text, a short one only whole", () => {
    expect(secret("pw-held-123")).toBe("pw-held-123");
    expect(holdsSecret("x pw-held-123 y")).toBe(true);
    expect(holdsSecret("1234", ["1234"])).toBe(true);
    expect(holdsSecret("a1234b", ["1234"])).toBe(false);
  });
});

describe("scrubKeptTraces", () => {
  let dir = "";
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("scrubs this disk in place and the backup's own copies, once each", async () => {
    dir = await mkdtemp(join(tmpdir(), "trace-scrub-"));
    const artifacts = join(dir, "artifacts");
    const kept = join(dir, "kept");
    const only = join(kept, "traces", "box", "artifacts", "old.zip");
    await mkdir(artifacts, { recursive: true });
    await mkdir(join(kept, "traces", "box", "artifacts"), { recursive: true });
    await writeFile(join(artifacts, "new.zip"), fixture());
    await writeFile(only, fixture());
    let pushes = 0;
    const run = () =>
      scrubKeptTraces({
        dirs: [{ name: "artifacts", dir: artifacts }],
        ledgerFile: join(dir, "kept.tsv"),
        prefix: "traces/mac/",
        store: dirTraceStore(kept),
        doneFile: join(dir, "scrubbed.tsv"),
        workDir: join(dir, "work"),
        under: "traces/",
        push: async () => {
          pushes++;
          return { shipped: 1, bytes: 1, pending: 0, unreadable: [], refused: null };
        },
        backup: true,
      });
    const r = await run();
    expect(r.local).toMatchObject({ traces: 1, changed: 1, leaks: 0, failed: 0 });
    expect(r.backup).toMatchObject({ traces: 1, changed: 1, leaks: 0, failed: 0 });
    expect(pushes).toBe(1);
    expect(r.pushed?.shipped).toBe(1);
    for (const f of [join(artifacts, "new.zip"), only])
      expect(await unzipped(f)).not.toContain(PASSWORD);
    const again = await run();
    expect(again.local.traces + again.backup.traces).toBe(0);
  });
});
