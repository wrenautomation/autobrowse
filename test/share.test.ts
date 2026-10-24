import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { knownFromTrace } from "../src/share/scrub.js";
import {
  excluded,
  queued,
  readShare,
  sendShared,
  shareFlow,
  shareOff,
  shareTrace,
  writeShare,
} from "../src/share/share.js";

const TYPED = "Hunter Valley Road 42";
const rawTrace = () =>
  zipSync({
    "trace.trace": strToU8(
      [
        { type: "before", method: "fill", params: { selector: "#a", value: TYPED } },
        { type: "after", result: { value: TYPED } },
        { type: "log", message: `typed ${TYPED}` },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    ),
    "screencast/p.jpeg": new Uint8Array([1]),
  });

function home() {
  const dir = mkdtempSync(join(tmpdir(), "share-"));
  return { dir, env: { AUTOBROWSE_SHARE_DIR: dir } as NodeJS.ProcessEnv };
}

describe("share switch", () => {
  it("is on by default; env, DO_NOT_TRACK and the state turn it off", () => {
    const { dir, env } = home();
    expect(shareOff(env)).toBeNull();
    expect(shareOff({ ...env, AUTOBROWSE_SHARE: "off" })).toBe("AUTOBROWSE_SHARE=off");
    expect(shareOff({ ...env, DO_NOT_TRACK: "1" })).toBe("DO_NOT_TRACK");
    writeShare({ ...readShare(dir), off: true }, dir);
    expect(shareOff(env)).toBe("autobrowse share off");
  });

  it("keeps one random install id", () => {
    const { dir } = home();
    const id = readShare(dir).installId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readShare(dir).installId).toBe(id);
  });

  it("excludes personal profiles, a site and a profile", () => {
    const s = { installId: "x", exclude: ["github", "x@wren"] };
    expect(excluded("linkedin", s)).toBe(true);
    expect(excluded("github@wren", s)).toBe(true);
    expect(excluded("x@wren", s)).toBe(true);
    expect(excluded("x@other", s)).toBe(false);
    expect(excluded("gmail@wren", s)).toBe(false);
  });
});

describe("shareTrace", () => {
  it("reads what the run typed from the trace itself", () => {
    expect(knownFromTrace(rawTrace())).toEqual([{ value: TYPED, kind: "typed" }]);
  });

  it("queues a scrubbed copy and leaves the raw zip", async () => {
    const { dir, env } = home();
    const raw = join(dir, "raw.zip");
    writeFileSync(raw, rawTrace());
    expect(await shareTrace(raw, { site: "github@wren", flow: "login", outcome: "ok" }, env)).toBe(
      "queued",
    );
    const [file] = queued(dir);
    expect(file?.name).toMatch(/\.github\.login\.ok\.zip$/);
    const out = unzipSync(readFileSync(join(dir, "queue", file?.name ?? "")));
    expect(Object.keys(out)).toEqual(["trace.trace"]);
    expect(strFromU8(out["trace.trace"] as Uint8Array)).not.toContain("Hunter");
    expect(readFileSync(raw).length).toBeGreaterThan(0);
  });

  it("queues nothing when off or excluded", async () => {
    const { dir, env } = home();
    const raw = join(dir, "raw.zip");
    writeFileSync(raw, rawTrace());
    const meta = { site: "linkedin", flow: "f", outcome: "ok" };
    expect(await shareTrace(raw, meta, env)).toBe("excluded");
    expect(await shareTrace(raw, { ...meta, site: "a" }, { ...env, DO_NOT_TRACK: "1" })).toBe(
      "off",
    );
    expect(queued(dir)).toEqual([]);
  });
});

describe("shareFlow", () => {
  it("queues a passed flow's source and proof, scrubbed, without read values or tests", async () => {
    const { dir, env } = home();
    const flow = join(dir, "acme-signup");
    mkdirSync(flow);
    writeFileSync(
      join(flow, "outline.json"),
      JSON.stringify({ name: "acme-signup", site: "acme" }),
    );
    writeFileSync(join(flow, "index.ts"), `// tried ${TYPED}\nexport default {};`);
    writeFileSync(join(flow, "index.test.ts"), "test");
    const proof = {
      at: "2026-10-24",
      status: "done",
      steps: [{ name: "fill", status: "ok", detail: `typed ${TYPED}` }],
      output: { orderId: "ORD-99887766" },
    };
    expect(await shareFlow(flow, proof, { street: TYPED }, env)).toBe("queued");
    const [file] = queued(dir);
    expect(file?.name).toMatch(/\.acme-signup\.flow\.json$/);
    const body = readFileSync(join(dir, "queue", file?.name ?? ""), "utf8");
    expect(body).not.toContain("Hunter");
    expect(body).not.toContain("99887766");
    const pack = JSON.parse(body);
    expect(Object.keys(pack.files).sort()).toEqual(["index.ts", "outline.json"]);
    expect(pack.proof.output).toEqual(["orderId"]);
    expect(await shareFlow(flow, { ...proof, status: "failed" }, {}, env)).toBe("error");

    const bare = join(dir, "bare-flow");
    mkdirSync(bare);
    writeFileSync(join(bare, "index.ts"), 'const f = defineFlow({ site: "acme", name: "x" });');
    expect(await shareFlow(bare, proof, {}, env)).toBe("queued");
    expect(queued(dir).some((f) => f.name.endsWith(".bare-flow.flow.json"))).toBe(true);
  });
});

describe("sendShared", () => {
  const fill = (dir: string, names: string[]) => {
    for (const n of names) {
      const q = join(dir, "queue");
      mkdirSync(q, { recursive: true });
      writeFileSync(join(q, n), "z");
    }
  };

  it("sends oldest first with the install id; 2xx and 4xx leave, a 5xx stops", async () => {
    const { dir, env } = home();
    fill(dir, ["1.a.zip", "2.b.zip", "3.c.flow.json", "4.d.zip"]);
    const seen: { url: string; install: string | null }[] = [];
    const status = [200, 400, 503];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, install: new Headers(init.headers).get("x-install") });
      return new Response(null, { status: status[seen.length - 1] });
    }) as typeof globalThis.fetch;
    const r = await sendShared({ env: { ...env, AUTOBROWSE_SHARE_URL: "https://s.test" }, fetch });
    expect(r).toEqual({ sent: 1, dropped: 1, left: 2, stopped: "http 503" });
    expect(seen.map((s) => s.url)).toEqual([
      "https://s.test/v1/traces/1.a.zip",
      "https://s.test/v1/traces/2.b.zip",
      "https://s.test/v1/flows/3.c.flow.json",
    ]);
    expect(seen[0]?.install).toBe(readShare(dir).installId);
    expect(readdirSync(join(dir, "queue")).sort()).toEqual(["3.c.flow.json", "4.d.zip"]);
  });

  it("sends nothing when off", async () => {
    const { dir, env } = home();
    fill(dir, ["1.a.zip"]);
    const r = await sendShared({
      env: { ...env, AUTOBROWSE_SHARE: "off" },
      fetch: (() => {
        throw new Error("no");
      }) as unknown as typeof fetch,
    });
    expect(r).toEqual({ sent: 0, dropped: 0, left: 1, stopped: "AUTOBROWSE_SHARE=off" });
  });
});
