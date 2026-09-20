import { describe, expect, it } from "vitest";
import { Jobs } from "../src/ui/jobs.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("Jobs", () => {
  it("answers at once, joins a running job on the same key, keeps results and failures", async () => {
    const jobs = new Jobs({ keep: 2 });
    let release: (v: string) => void = () => undefined;
    const a = jobs.start("prove", "x", () => new Promise<string>((r) => (release = r)));
    expect(a.status).toBe("running");
    expect(jobs.start("prove", "x", async () => "other").id).toBe(a.id);
    expect(jobs.start("prove", "y", async () => "y").id).not.toBe(a.id);
    // wait: holds until settled, or gives the running job back after ms.
    expect((await jobs.wait(a.id, 1))?.status).toBe("running");
    expect(await jobs.wait("nope", 1)).toBeNull();
    const held = jobs.wait(a.id, 5_000);
    release("done x");
    expect((await held)?.status).toBe("done");
    await tick();
    expect(jobs.get(a.id)).toMatchObject({ status: "done", result: "done x" });
    expect(jobs.get(a.id)?.finishedAt).not.toBeNull();
    // After it finished, the key is free again.
    expect(jobs.start("prove", "x", async () => "again").id).not.toBe(a.id);
    const f = jobs.start("heal", "z", async () => {
      throw new Error("no way");
    });
    await tick();
    expect(jobs.get(f.id)).toMatchObject({ status: "failed", error: "no way" });
    // Only the newest `keep` finished jobs stay.
    expect(jobs.list().filter((j) => j.status !== "running").length).toBe(2);
  });
});
