import { describe, expect, it } from "vitest";
import { memoryEffects, runFlow } from "../../index.js";
import { planSchema, setSkipPasswordsFlow, workflow } from "./index.js";

describe("workspace-skip-passwords", () => {
  it("targets on by default", () => {
    expect(planSchema.parse({})).toEqual({ dryRun: false, enabled: true });
  });

  it("reports whether the box had to move", async () => {
    for (const changed of [true, false]) {
      const deps = { browser: { run: async () => ({ changed }) as never } };
      const out = await runFlow(memoryEffects().fx, workflow, deps, planSchema.parse({}));
      expect(out.status).toBe("done");
      expect(out.results["set-skip-passwords"]?.detail).toBe(
        changed ? "skip passwords turned on" : "skip passwords already on",
      );
    }
  });

  it("dry run plans and stops before anything irreversible", async () => {
    const deps = { browser: { run: async () => undefined as never } };
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      deps,
      planSchema.parse({ dryRun: true }),
    );
    expect(out.status).toBe("planned");
    expect(out.results["set-skip-passwords"]?.status).toBe("planned");
  });

  it("reads the box before clicking", async () => {
    const acts: string[] = [];
    const fp = {
      open: async () => undefined,
      act: async (_op: unknown, _h: unknown, o: { goal: string }) => void acts.push(o.goal),
      page: {
        getByRole: () => ({ waitFor: async () => undefined, isChecked: async () => true }),
      },
    };
    expect(await setSkipPasswordsFlow.run(fp as never, { enabled: true })).toEqual({
      changed: false,
    });
    expect(acts).toEqual(["open the Skip passwords editor"]);
    expect(await setSkipPasswordsFlow.run(fp as never, { enabled: false })).toEqual({
      changed: true,
    });
    expect(acts.at(-1)).toBe("save the setting");
  });
});
