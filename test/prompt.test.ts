import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { askSecret, askSecretTwice } from "../src/app/prompt.js";

/** A terminal that hands over the bytes a person would type. */
function fakeTty(script: string[]) {
  const written: string[] = [];
  let raw = false;
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    get isRaw() {
      return raw;
    },
    setRawMode(on: boolean) {
      raw = on;
      return input;
    },
    resume() {
      return input;
    },
    pause() {
      return input;
    },
    off(name: string, fn: (...a: never[]) => void) {
      input.removeListener(name, fn);
      return input;
    },
  });
  const out = { write: (s: string) => written.push(s) };
  // One line per ask, delivered once the ask is listening.
  const feed = () => {
    const line = script.shift();
    if (line === undefined) return;
    setImmediate(() => input.emit("data", Buffer.from(line)));
  };
  return { input, out, written, feed, isRaw: () => raw };
}

const io = (t: ReturnType<typeof fakeTty>) =>
  ({ in: t.input, out: t.out }) as unknown as Parameters<typeof askSecret>[1];

describe("askSecret", () => {
  it("returns the line, echoes nothing, and puts the terminal back", async () => {
    const t = fakeTty(["hunter2\r"]);
    const p = askSecret("password: ", io(t));
    t.feed();
    expect(await p).toBe("hunter2");
    expect(t.written.join("")).toBe("password: \n");
    expect(t.isRaw()).toBe(false);
  });

  it("backspace drops a whole character, not a byte", async () => {
    const t = fakeTty(["aé\u007f\u007fb\n"]);
    const p = askSecret("x: ", io(t));
    t.feed();
    expect(await p).toBe("b");
  });

  it("Ctrl-C cancels and still puts the terminal back", async () => {
    const t = fakeTty(["ab\u0003"]);
    const p = askSecret("x: ", io(t));
    t.feed();
    await expect(p).rejects.toThrow(/cancelled/);
    expect(t.isRaw()).toBe(false);
  });

  it("refuses when this is not a terminal", async () => {
    await expect(
      askSecret("x: ", { in: { isTTY: false } as never, out: { write() {} } as never }),
    ).rejects.toThrow(/only be typed on a terminal/);
  });
});

describe("askSecretTwice", () => {
  it("wants the same value twice", async () => {
    const t = fakeTty(["correct horse battery\r", "correct horse battery\r"]);
    const p = askSecretTwice("password", { io: io(t) as never });
    t.feed();
    setTimeout(() => t.feed(), 5);
    expect(await p).toBe("correct horse battery");
  });

  it("refuses a mismatch and a short one, before anything is stored", async () => {
    const short = fakeTty(["short\r"]);
    const a = askSecretTwice("password", { io: io(short) as never });
    short.feed();
    await expect(a).rejects.toThrow(/too short/);

    const t = fakeTty(["correct horse battery\r", "correct horse batterz\r"]);
    const b = askSecretTwice("password", { io: io(t) as never });
    t.feed();
    setTimeout(() => t.feed(), 5);
    await expect(b).rejects.toThrow(/did not match/);
  });
});
