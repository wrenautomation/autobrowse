import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addFlow,
  approvePack,
  checkPack,
  type FlowPack,
  gateShared,
  REGISTRY_MARK,
  REGISTRY_RAW,
  REPROOF_PLAN,
  reproofRegistry,
} from "../src/share/gate.js";
import { type ShareAdmin, shareAdmin } from "../src/share/presidio.js";

const SRC = `import { z } from "zod";
import { defineWorkflow } from "../../index.js";
import { steps } from "./steps.js";
const cfg = { process: 1 };
export default defineWorkflow({ name: "acme-signup", plan: z.object({}), steps, x: cfg.process });
`;

const pack = (index = SRC, more: Record<string, string> = {}): FlowPack => ({
  name: "acme-signup",
  site: "acme",
  files: {
    "index.ts": index,
    "steps.ts": "export const steps = [];",
    "outline.json": JSON.stringify({ name: "acme-signup", site: "acme", description: "Sign up" }),
    ...more,
  },
  proof: { at: "2026-10-24T00:00:00Z", status: "done", steps: [], output: [] },
});

/** The ingest's admin routes over a Map. */
function memAdmin(): { admin: ShareAdmin; store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace("/admin/", "");
    if (path === "list") {
      const prefix = u.searchParams.get("prefix") ?? "";
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
      return Response.json({ keys, cursor: null });
    }
    const key = decodeURIComponent(path.slice("object/".length));
    if (init.method === "GET")
      return store.has(key) ? new Response(store.get(key)) : new Response(null, { status: 404 });
    if (init.method === "DELETE") store.delete(key);
    if (init.method === "PUT")
      store.set(
        key,
        typeof init.body === "string"
          ? new TextEncoder().encode(init.body)
          : new Uint8Array(init.body as Buffer),
      );
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { admin: shareAdmin("t", "https://s.test", f), store };
}

describe("checkPack", () => {
  it("passes a flow that imports only the library, zod and its own files", async () => {
    expect(await checkPack(pack())).toEqual([]);
  });

  it("refuses machine reach, network, eval, foreign imports and literal values", async () => {
    const bad = async (code: string) => (await checkPack(pack(code))).join("; ");
    expect(await bad(`import { exec } from "node:child_process";`)).toMatch(
      /imports node:child_process/,
    );
    expect(await bad("const k = process.env.KEY;")).toMatch(/uses process/);
    expect(await bad(`await fetch("https://x.test");`)).toMatch(/uses fetch/);
    expect(await bad(`const m = await import("fs");`)).toMatch(/dynamic import/);
    expect(await bad(`eval("1");`)).toMatch(/uses eval/);
    expect(await bad(`const to = "ada@example.org";`)).toMatch(/personal data/);
    expect(await bad("const x = ;")).toMatch(/does not parse/);
    expect(await bad(`import { y } from "./nope.js";`)).toMatch(/imports \.\/nope\.js/);
    expect(await checkPack({ ...pack(), name: "../x" })).toEqual(["name"]);
    expect(await checkPack({ ...pack(), files: { "../a.ts": "" } })).toEqual(["file ../a.ts"]);
  });
});

describe("gateShared", () => {
  it("moves kept packs to review or refused, once per id", async () => {
    const { admin, store } = memAdmin();
    const put = (k: string, p: unknown) =>
      store.set(k, new TextEncoder().encode(JSON.stringify(p)));
    put("kept/flows/d/i1/a.flow.json", pack());
    put("kept/flows/d/i2/a.flow.json", pack());
    put("kept/flows/d/i1/b.flow.json", pack(`import "node:fs";`));
    expect(await gateShared(admin)).toEqual({ review: 1, refused: 1, seen: 1 });
    const keys = [...store.keys()].sort();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^gate\/refused\/acme-signup-[0-9a-f]{8}\.json$/);
    expect(keys[1]).toMatch(/^gate\/review\/acme-signup-[0-9a-f]{8}\.json$/);
  });
});

describe("approvePack", () => {
  it("writes the flow and its index entry, opens the PR and merges it", async () => {
    const { admin, store } = memAdmin();
    store.set(
      "gate/review/acme-signup-1.json",
      new TextEncoder().encode(JSON.stringify({ id: "acme-signup-1", pack: pack(), reasons: [] })),
    );
    const calls: string[] = [];
    let seen: { index: string; files: string[]; lib: string } | null = null;
    const exec = async (cmd: string, args: string[], cwd?: string) => {
      calls.push(`${cmd} ${args[0]}`);
      if (cmd === "gh" && args[0] === "repo")
        writeFileSync(join(args[3] ?? "", "index.json"), '{"flows":[]}');
      if (cmd === "git" && args[0] === "commit" && cwd) {
        const dir = join(cwd, "flows/acme-signup");
        seen = {
          index: readFileSync(join(cwd, "index.json"), "utf8"),
          files: ["index.ts", "steps.ts", "outline.json", "proof.json"].filter((f) =>
            existsSync(join(dir, f)),
          ),
          lib: readFileSync(join(dir, "index.ts"), "utf8"),
        };
      }
      return cmd === "gh" && args[0] === "pr" && args[1] === "create" ? "https://pr.test/1\n" : "";
    };
    expect(await approvePack(admin, "acme-signup-1", exec)).toBe("https://pr.test/1");
    expect(calls).toEqual([
      "gh repo",
      "git checkout",
      "git add",
      "git commit",
      "git push",
      "gh pr",
      "gh pr",
    ]);
    const s = seen as unknown as { index: string; files: string[]; lib: string };
    expect(s.files).toHaveLength(4);
    expect(s.lib).toContain(`from "@wrenautomation/autobrowse"`);
    expect(JSON.parse(s.index).flows[0]).toMatchObject({ name: "acme-signup", site: "acme" });
    expect([...store.keys()]).toEqual(["gate/approved/acme-signup-1.json"]);
  });
});

describe("addFlow", () => {
  it("copies a registry flow with the library import set for this install", async () => {
    const root = mkdtempSync(join(tmpdir(), "flows-"));
    const files: Record<string, string> = {
      "index.json": JSON.stringify({
        flows: [{ name: "acme-signup", site: "acme", files: ["index.ts", "outline.json"] }],
      }),
      "flows/acme-signup/index.ts": `import { a } from "@wrenautomation/autobrowse";`,
      "flows/acme-signup/outline.json": "{}",
    };
    const f = (async (url: string) => {
      const body = files[url.slice(REGISTRY_RAW.length + 1)];
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    }) as typeof fetch;
    await addFlow("acme-signup", { root, lib: "../../index.js", fetch: f });
    expect(readFileSync(join(root, "acme-signup/index.ts"), "utf8")).toBe(
      `import { a } from "../../index.js";`,
    );
    await expect(addFlow("acme-signup", { root, lib: "x", fetch: f })).rejects.toThrow(/exists/);
    await expect(addFlow("nope", { root, lib: "x", fetch: f })).rejects.toThrow(/no flow nope/);
  });
});

describe("reproofRegistry", () => {
  it("proves registry flows with a plan; a failure opens one issue", async () => {
    const root = mkdtempSync(join(tmpdir(), "reproof-"));
    for (const [name, mark, plan] of [
      ["ok-flow", true, true],
      ["bad-flow", true, true],
      ["own-flow", false, true],
      ["no-plan", true, false],
    ] as const) {
      mkdirSync(join(root, name));
      if (mark) writeFileSync(join(root, name, REGISTRY_MARK), "{}");
      if (plan) writeFileSync(join(root, name, REPROOF_PLAN), '{"a":1}');
    }
    const proved: string[] = [];
    const calls: string[] = [];
    const r = await reproofRegistry(
      root,
      async (name) => {
        proved.push(name);
        return { status: name === "ok-flow" ? "done" : "failed" };
      },
      async (_cmd, args) => {
        calls.push(`${args[0]} ${args[1]}`);
        return args[1] === "list" ? "[]" : "";
      },
    );
    expect(proved.sort()).toEqual(["bad-flow", "ok-flow"]);
    expect(r).toEqual({ proven: 1, broken: ["bad-flow"] });
    expect(calls).toEqual(["issue list", "issue create"]);
  });
});
