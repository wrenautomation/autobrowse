import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Ingress } from "../src/app/client.js";
import type { OpenGate, RunStatusView } from "../src/engine/object.js";
import type { RunRow } from "../src/engine/registry.js";
import { saveRecording } from "../src/recorder/store.js";
import { api } from "../src/ui/api.js";
import { eventBus } from "../src/ui/bus.js";
import { domainWorkflow } from "../src/workflows/domain/index.js";

const gate: OpenGate = {
  name: "purchase",
  step: "buy",
  prompt: "Buy x.com?",
  openedAt: "2026-09-19T12:00:00Z",
};

/** One waiting run and a log of every ingress call. */
function fakeIngress() {
  const calls: string[] = [];
  const rows: RunRow[] = [
    {
      workflow: "domain",
      key: "x.com",
      startedAt: "t",
      updatedAt: "t",
      status: "waiting",
      gate: "purchase",
      lastStep: "check",
    },
  ];
  const run = {
    run: async (plan: unknown) => void calls.push(`run ${JSON.stringify(plan)}`),
    step: async () => undefined,
    pause: async () => void calls.push("pause"),
    play: async () => void calls.push("play"),
    reset: async () => void calls.push("reset"),
    approve: async (a: { name: string; note?: string }) => {
      calls.push(`approve ${a.name} ${a.note ?? ""}`);
      return gate;
    },
    reject: async (a: { name: string; note?: string }) => {
      calls.push(`reject ${a.name} ${a.note ?? ""}`);
      return gate;
    },
    status: async (): Promise<RunStatusView> => ({
      workflow: "domain",
      key: "x.com",
      plan: {},
      gate,
      paused: false,
      outcome: null,
    }),
  };
  const ingress = {
    run: () => run,
    registry: () => ({
      list: async () => rows,
      record: async () => undefined,
      forget: async () => undefined,
    }),
  } as unknown as Ingress;
  return { ingress, calls };
}

async function setup(token?: string) {
  const dir = await mkdtemp(join(tmpdir(), "api-"));
  const recordingsDir = join(dir, "rec");
  await saveRecording(recordingsDir, {
    name: "chore",
    site: "scratch",
    startedAt: "2026-09-19T10:00:00Z",
    finishedAt: "2026-09-19T10:01:00Z",
    actions: [{ t: 0, kind: "navigate", url: "https://x.test/a" }],
    trace: null,
    terminal: null,
    commands: ["echo hi"],
  });
  await writeFile(join(recordingsDir, "chore", "shot.png"), "png");
  const { ingress, calls } = fakeIngress();
  const bus = eventBus();
  const app = api({
    workflows: [domainWorkflow],
    ingress,
    bus,
    recordingsDir,
    artifactsDir: join(dir, "art"),
    compile: async (rec) => ({
      outline: { name: rec.name } as never,
      usage: null,
      files: { "index.ts": "//" },
    }),
    token,
  });
  return { app, calls, bus, dir };
}

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? null : JSON.stringify(body),
  });

describe("api", () => {
  it("lists workflows with a JSON schema for the plan", async () => {
    const { app } = await setup();
    const body = await (await app.request("/api/workflows")).json();
    expect(body[0].name).toBe("domain");
    expect(body[0].steps.find((s: { name: string }) => s.name === "buy").irreversible).toBe(true);
    expect(body[0].plan.properties.domain).toBeDefined();
  });

  it("starts, answers and controls runs through the ingress", async () => {
    const { app, calls } = await setup();
    expect(
      (
        await app.request(
          post("/api/runs/domain/x.com", {
            plan: {
              domain: "x.com",
              inboxes: [{ local: "wi", givenName: "Wi", familyName: "Jin" }],
            },
          }),
        )
      ).status,
    ).toBe(202);
    expect((await app.request(post("/api/runs/domain/x.com", { plan: { nope: 1 } }))).status).toBe(
      400,
    );
    expect((await app.request(post("/api/runs/nope/x.com", { plan: {} }))).status).toBe(404);
    expect((await app.request(post("/api/runs/domain/x.com/approve", { note: "go" }))).status).toBe(
      200,
    );
    expect((await app.request(post("/api/runs/domain/x.com/pause"))).status).toBe(200);
    expect((await app.request(post("/api/runs/domain/x.com/explode"))).status).toBe(404);
    expect(calls).toEqual([expect.stringMatching(/^run .*x\.com/), "approve purchase go", "pause"]);
  });

  it("turns an inbound message into a command on the waiting run", async () => {
    const { app, calls } = await setup();
    const yes = await (
      await app.request(post("/hooks/inbound", { text: "yes looks fine" }))
    ).json();
    expect(yes.reply).toBe("domain/x.com: purchase approved");
    expect(calls).toEqual(["approve purchase looks fine"]);
    const status = await (await app.request(post("/hooks/inbound", { text: "status" }))).json();
    expect(status.reply).toMatch(/waiting at buy/);
    const huh = await (await app.request(post("/hooks/inbound", { text: "what" }))).json();
    expect(huh.reply).toMatch(/say yes, no/);
  });

  it("requires the bearer when one is set", async () => {
    const { app } = await setup("s3cret");
    expect((await app.request("/api/runs")).status).toBe(401);
    expect(
      (await app.request("/api/runs", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect(
      (await app.request("/api/runs", { headers: { authorization: "Bearer s3cret" } })).status,
    ).toBe(200);
  });

  it("serves recordings, their files (inside the dir only) and compiles them", async () => {
    const { app } = await setup();
    expect(
      ((await (await app.request("/api/recordings")).json()) as { name: string }[]).map(
        (r) => r.name,
      ),
    ).toEqual(["chore"]);
    expect((await app.request("/api/recordings/chore/files/shot.png")).status).toBe(200);
    expect((await app.request("/api/recordings/chore/files/../../x")).status).toBe(404);
    expect((await app.request("/api/recordings/Bad/files/x")).status).toBe(400);
    const compiled = await (await app.request(post("/api/recordings/chore/compile"))).json();
    expect(compiled.files["index.ts"]).toBe("//");
  });

  it("streams recent and live events", async () => {
    const { app, bus } = await setup();
    await bus.deliver({ type: "started", run: { workflow: "domain", key: "x.com" }, at: "t" });
    const res = await app.request("/api/events");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: started");
    await bus.deliver({ type: "paused", run: { workflow: "domain", key: "x.com" }, at: "t" });
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toContain("event: paused");
    await reader.cancel();
  });
});
