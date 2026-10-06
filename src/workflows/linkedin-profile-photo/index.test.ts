import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryEffects, runFlow } from "../../index.js";
import { type ProfilePhotoInput, planSchema, workflow } from "./index.js";

const png = (w: number, h: number) => {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const dir = mkdtempSync(join(tmpdir(), "li-photo-"));
const photo = join(dir, "me.png");
writeFileSync(photo, png(660, 660));

const deps = (runs: ProfilePhotoInput[]) => ({
  browser: {
    run: async (_flow: unknown, input: ProfilePhotoInput) => {
      runs.push(input);
      return { photo: input.file ? "new" : "old", outcome: input.file ? "saved" : "read" };
    },
  } as never,
});
const yes = () => ({ approved: true, note: null, at: new Date().toISOString() });

describe("linkedin-profile-photo", () => {
  it("dry run reads the profile and changes nothing", async () => {
    const runs: ProfilePhotoInput[] = [];
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      deps(runs),
      planSchema.parse({ dryRun: true, photoFile: photo }),
    );
    expect(out.status).toBe("planned");
    expect(runs).toEqual([{ file: null }]);
  });

  it("waits at the send gate, then sets the photo", async () => {
    const runs: ProfilePhotoInput[] = [];
    const { fx } = memoryEffects();
    const plan = planSchema.parse({ dryRun: false, photoFile: photo });
    expect((await runFlow(fx, workflow, deps(runs), plan)).status).toBe("waiting");
    const out = await runFlow(fx, workflow, deps(runs), plan, yes);
    expect(out.status).toBe("done");
    expect(runs.map((r) => r.file)).toEqual([null, photo]);
    expect(out.memo.saved).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stops before the browser on a photo LinkedIn would refuse", async () => {
    const runs: ProfilePhotoInput[] = [];
    const wide = join(dir, "wide.png");
    writeFileSync(wide, png(1600, 400));
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      deps(runs),
      planSchema.parse({ dryRun: true, photoFile: wide }),
    );
    expect(out.status).toBe("failed");
    expect(out.results.check?.detail).toContain("photo: 1600x400");
    expect(runs).toEqual([]);
  });
});
