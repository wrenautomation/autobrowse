import { describe, expect, it } from "vitest";
import { KeyedMutex } from "../src/browser/lock.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("KeyedMutex", () => {
  it("serialises the same key in arrival order and runs different keys at once", async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    let releaseA: () => void = () => undefined;
    const a = m.withLock("cf", async () => {
      log.push("a in");
      await new Promise<void>((r) => {
        releaseA = r;
      });
      log.push("a out");
    });
    await tick();
    const b = m.withLock("cf", async () => {
      log.push("b in");
    });
    const c = m.withLock("google", async () => {
      log.push("c in");
    });
    await tick();
    expect(log).toEqual(["a in", "c in"]);
    expect(m.busy).toBe(1);
    releaseA();
    await Promise.all([a, b, c]);
    expect(log).toEqual(["a in", "c in", "a out", "b in"]);
    expect(m.busy).toBe(0);
  });

  it("releases on a throw", async () => {
    const m = new KeyedMutex();
    await expect(
      m.withLock("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await m.withLock("k", async () => "next")).toBe("next");
    expect(m.busy).toBe(0);
  });
});
