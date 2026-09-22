import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { FlowRunner } from "../src/browser/flow.js";
import { awsCliLoginChore } from "../src/chores/aws-login.js";

/** A stand-in `aws login --remote`: prints the URL, reads the code, maybe asks to overwrite. */
function fakeAws(o: { asks?: boolean; region?: boolean } = {}) {
  const calls: { args: string[]; stdin: string } = { args: [], stdin: "" };
  const spawn = ((_cmd: string, args: string[]) => {
    calls.args = args;
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      exitCode: number | null;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.kill = () => undefined;
    let lines: string[] = [];
    child.stdin.on("data", (d: Buffer) => {
      calls.stdin += d.toString();
      lines = calls.stdin.split("\n");
      if (o.asks && lines.length === 2) {
        child.stdout.write("Profile default is already configured … (y/n): ");
      } else if ((lines.length === 2 && !o.asks) || lines.length === 3) {
        child.exitCode = lines[o.asks ? 1 : 0] === "" ? 1 : 0;
        if (o.asks && lines[1] !== "y") child.exitCode = 2;
        child.emit("exit", child.exitCode);
      }
    });
    setTimeout(() => {
      if (o.region) child.stdout.write("AWS Region [us-east-1]: ");
      else
        child.stdout.write(
          "Please visit https://us-east-1.signin.aws.amazon.com/v1/authorize?x=1\n",
        );
    }, 5);
    if (o.region)
      child.stdin.once("data", () =>
        child.stdout.write(
          "Please visit https://us-east-1.signin.aws.amazon.com/v1/authorize?x=2\n",
        ),
      );
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls };
}

const browser = (seen: string[]): FlowRunner => ({
  run: async (_flow, input) => {
    seen.push((input as { url: string }).url);
    return { code: "the-code" } as never;
  },
});

describe("aws-login chore", () => {
  it("opens the printed URL and pipes the code into the CLI", async () => {
    const seen: string[] = [];
    const aws = fakeAws();
    const r = await awsCliLoginChore(browser(seen), { spawn: aws.spawn, profile: "p" });
    expect(seen).toEqual(["https://us-east-1.signin.aws.amazon.com/v1/authorize?x=1"]);
    expect(aws.calls.args).toEqual(["login", "--remote", "--profile", "p"]);
    expect(aws.calls.stdin).toBe("the-code\n");
    expect(r.ok).toBe(true);
    expect(r.detail).not.toContain("the-code");
  });

  it("answers the overwrite prompt no unless asked", async () => {
    const no = fakeAws({ asks: true });
    expect((await awsCliLoginChore(browser([]), { spawn: no.spawn })).ok).toBe(false);
    expect(no.calls.stdin).toBe("the-code\nn\n");
    const yes = fakeAws({ asks: true });
    expect((await awsCliLoginChore(browser([]), { spawn: yes.spawn, overwrite: true })).ok).toBe(
      true,
    );
  });

  it("accepts the default region when the profile has none", async () => {
    const seen: string[] = [];
    const aws = fakeAws({ region: true });
    await awsCliLoginChore(browser(seen), { spawn: aws.spawn });
    expect(seen[0]).toContain("x=2");
    expect(aws.calls.stdin.startsWith("\n")).toBe(true);
  });
});
