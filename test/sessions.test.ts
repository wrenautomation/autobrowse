import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentSessions } from "../src/agent/sessions.js";
import type { ExploreCommand, Explorer } from "../src/explore/server.js";
import { fakeLlm } from "../src/llm/fake.js";

function fakeExplorer() {
  const calls: ExploreCommand[] = [];
  let paused = false;
  let waiters: Array<() => void> = [];
  let finish: () => void = () => undefined;
  const done = new Promise<void>((r) => {
    finish = r;
  });
  const ex: Explorer = {
    port: 0,
    token: "t",
    paused: () => paused,
    resumed: () => (paused ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()),
    done,
    async exec(c) {
      calls.push(c);
      switch (c.cmd) {
        case "url":
          return { url: "https://site.test/" };
        case "aria":
          return { aria: '- button "Go"' };
        case "pause":
          paused = true;
          return { paused };
        case "resume":
          paused = false;
          for (const w of waiters) w();
          waiters = [];
          return { paused };
        case "screenshot":
          return { file: `/shots/${calls.length}.png` };
        case "click":
          await new Promise((r) => setTimeout(r, 30)); // a real click takes a beat
          return { ok: true };
        case "save":
          return { dir: `/rec/${c.name}` };
        case "close":
          finish();
          return { closed: true };
        default:
          return { ok: true };
      }
    },
  };
  return { ex, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("agentSessions", () => {
  it("runs a session to done, keeps steps with screenshots, saves and closes", async () => {
    const { ex, calls } = fakeExplorer();
    const llm = fakeLlm([
      { thought: "go", action: { cmd: "click", ref: 1, goal: "go" } },
      { thought: "there", action: { cmd: "done", summary: "arrived", achieved: true } },
    ]);
    const s = agentSessions({ llm, open: async () => ex, basePort: 9500 });
    const v = await s.start({ site: "site", goal: "arrive" });
    expect(v.port).toBe(9500);
    for (let i = 0; i < 20 && s.get(v.id)?.status !== "done"; i++) await tick();
    const done = s.get(v.id);
    expect(done).toMatchObject({ status: "done", achieved: true, summary: "arrived" });
    expect(done?.steps.map((x) => x.step?.action.cmd)).toEqual(["click", "done"]);
    await tick();
    expect(done?.steps[0]?.screenshot).toMatch(/\.png$/);
    await s.save(v.id, "arrive");
    expect(s.get(v.id)?.recording).toBe("/rec/arrive");
    await s.close(v.id);
    expect(s.get(v.id)?.status).toBe("closed");
    expect(calls.at(-1)?.cmd).toBe("close");
  });
  it("pause holds the agent, resume lets it go, stop ends it", async () => {
    const { ex } = fakeExplorer();
    const llm = fakeLlm(
      Array.from({ length: 10 }, () => ({
        thought: "again",
        action: { cmd: "click", ref: 1, goal: "g" },
      })),
    );
    const s = agentSessions({ llm, open: async () => ex, basePort: 9500 });
    const v = await s.start({ site: "site", goal: "loop", maxSteps: 10 });
    await tick();
    await s.pause(v.id);
    const at = s.get(v.id)?.steps.length ?? 0;
    await tick();
    await tick();
    expect(s.get(v.id)?.status).toBe("paused");
    expect(s.get(v.id)?.steps.length).toBeLessThanOrEqual(at + 1);
    await s.resume(v.id);
    expect(s.get(v.id)?.status).toBe("running");
    const stopped = await s.stop(v.id);
    expect(stopped.status).toBe("stopped");
    expect(stopped.summary).toBe("stopped by a person");
    expect(stopped.steps.length).toBeLessThan(10);
  });
  it("human = a pause with a prompt; resume lets the agent go on", async () => {
    const { ex } = fakeExplorer();
    const llm = fakeLlm([
      { thought: "captcha", action: { cmd: "human", reason: "a captcha" } },
      { thought: "past it", action: { cmd: "done", summary: "through", achieved: true } },
    ]);
    const s = agentSessions({ llm, open: async () => ex, basePort: 9700 });
    const v = await s.start({ site: "site", goal: "g" });
    for (let i = 0; i < 20 && s.get(v.id)?.status !== "needs-human"; i++) await tick();
    expect(s.get(v.id)).toMatchObject({ status: "needs-human", prompt: "a captcha" });
    expect(ex.paused()).toBe(true);
    await s.resume(v.id);
    for (let i = 0; i < 20 && s.get(v.id)?.status !== "done"; i++) await tick();
    expect(s.get(v.id)).toMatchObject({ status: "done", achieved: true, prompt: null });
  });
  it("views persist to disk and come back closed after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"));
    const llm = fakeLlm([{ thought: "x", action: { cmd: "done", summary: "s", achieved: true } }]);
    const first = agentSessions({ llm, open: async () => fakeExplorer().ex, basePort: 9650, dir });
    const v = await first.start({ site: "a", goal: "persisted" });
    for (let i = 0; i < 20 && first.get(v.id)?.status !== "done"; i++) await tick();
    expect(readdirSync(dir)).toEqual([`${v.id}.json`]);
    // A second session dies mid-run (no done reply scripted): it is "running" on disk.
    const stuck = agentSessions({ llm: fakeLlm([]), open: async () => fakeExplorer().ex, dir });
    const w = await stuck.start({ site: "b", goal: "interrupted" }).catch(() => null);
    await tick();
    const again = agentSessions({ llm, open: async () => fakeExplorer().ex, dir });
    const views = again.list();
    expect(views.find((x) => x.id === v.id)).toMatchObject({ status: "done", goal: "persisted" });
    if (w) expect(views.find((x) => x.id === w.id)?.status).toMatch(/closed|failed/);
  });
  it("a person's exec is refused while the agent runs, allowed once paused, never close/save", async () => {
    const { ex, calls } = fakeExplorer();
    const llm = fakeLlm(
      Array.from({ length: 6 }, () => ({
        thought: "t",
        action: { cmd: "click", ref: 1, goal: "g" },
      })),
    );
    const s = agentSessions({ llm, open: async () => ex, basePort: 9660 });
    const v = await s.start({ site: "site", goal: "g", maxSteps: 6 });
    await tick();
    await expect(s.exec(v.id, { cmd: "note", text: "hi" })).rejects.toThrow(
      /pause the agent first/,
    );
    await s.pause(v.id);
    await tick();
    await s.exec(v.id, { cmd: "note", text: "hi" });
    expect(calls.some((c) => c.cmd === "note" && c.text === "hi")).toBe(true);
    await expect(s.exec(v.id, { cmd: "close" })).rejects.toThrow(/use the close action/);
    await s.stop(v.id);
  });
  it("ports do not collide between live sessions", async () => {
    const llm = fakeLlm([{ thought: "x", action: { cmd: "done", summary: "s", achieved: true } }]);
    const s = agentSessions({ llm, open: async () => fakeExplorer().ex, basePort: 9600 });
    const a = await s.start({ site: "a", goal: "g" });
    const b = await s.start({ site: "b", goal: "g" });
    expect([a.port, b.port]).toEqual([9600, 9601]);
  });
});
