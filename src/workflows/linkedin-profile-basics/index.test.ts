import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryEffects, runFlow } from "../../index.js";
import { type BasicsInput, bareUrl, type Profile, planSchema, workflow } from "./index.js";

const png = (w: number, h: number) => {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const dir = mkdtempSync(join(tmpdir(), "li-basics-"));
const photo = join(dir, "me.png");
writeFileSync(photo, png(660, 660));

const read: Profile = {
  firstName: "Test",
  lastName: "Person",
  headline: "Founder at Example",
  city: "Toronto, Ontario, Canada",
  about: "",
  websites: [],
  positions: ["Founder Wren Automation Oct 2026 - Present · 1 mo"],
};

type Call = { site: string; input: BasicsInput | { file: string | null } };
const deps = (calls: Call[], profile = read) => ({
  browser: {
    run: async (flow: { site: string }, input: Call["input"]) => {
      calls.push({ site: flow.site, input });
      if ("file" in input) return { photo: "new", outcome: "saved" };
      return { profile, changed: input.part !== "read" };
    },
  } as never,
});
const yes = () => ({ approved: true, note: null, at: new Date().toISOString() });
const parts = (calls: Call[]) => calls.map((c) => ("part" in c.input ? c.input.part : "photo"));

describe("linkedin-profile-basics", () => {
  it("dry run reads linkedin@wren and changes nothing", async () => {
    const calls: Call[] = [];
    const plan = planSchema.parse({ dryRun: true, photoFile: photo });
    const out = await runFlow(memoryEffects().fx, workflow, deps(calls), plan);
    expect(out.status).toBe("planned");
    expect(calls).toEqual([{ site: "linkedin@wren", input: { part: "read" } }]);
  });

  it("gates each part, sets them in order, and a rerun skips them", async () => {
    const calls: Call[] = [];
    const { fx } = memoryEffects();
    const plan = planSchema.parse({ photoFile: photo });
    expect((await runFlow(fx, workflow, deps(calls), plan)).status).toBe("waiting");
    const out = await runFlow(fx, workflow, deps(calls), plan, yes);
    expect(out.status).toBe("done");
    expect(parts(calls)).toEqual(["read", "intro", "about", "websites", "photo"]);
    expect(calls.every((c) => c.site === "linkedin@wren")).toBe(true);
    expect(calls[1]?.input).toMatchObject({ firstName: "Will", lastName: "Jin" });
    expect(Object.keys(out.memo).sort()).toEqual(["about", "intro", "photo", "websites"]);

    // A new run with the same values: every part skips on the memo.
    const again: Call[] = [];
    const rerun = await runFlow(fx, workflow, deps(again), plan, yes);
    expect(rerun.status).toBe("done");
    expect(parts(again).filter((p) => p !== "read")).toEqual([]);
  });

  it("stops before any edit when the position is missing", async () => {
    const calls: Call[] = [];
    const plan = planSchema.parse({ photoFile: photo });
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      deps(calls, { ...read, positions: [] }),
      plan,
      yes,
    );
    expect(out.status).toBe("failed");
    expect(out.results.check?.detail).toContain("add it by hand");
    expect(parts(calls)).toEqual(["read"]);
  });

  it("matches a website however LinkedIn echoes it", () => {
    expect(bareUrl("https://www.Wrenautomation.com/")).toBe(bareUrl("wrenautomation.com"));
  });
});
