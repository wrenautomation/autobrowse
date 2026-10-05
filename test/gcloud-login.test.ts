import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { FlowRunner } from "../src/browser/flow.js";
import { gcloudLoginChore } from "../src/chores/gcloud-login.js";

const URL =
  "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fsdk.cloud.google.com%2Fauthcode.html&state=abc";

/** A stand-in `gcloud auth login --no-launch-browser`: prints the URL, reads a code, exits. */
function fakeGcloud(o: { noUrl?: boolean } = {}) {
  const calls = { args: [] as string[], code: "" };
  const spawn = ((_cmd: string, args: string[]) => {
    calls.args = args;
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    child.stdin.on("data", (d: Buffer) => {
      calls.code += d.toString();
      setTimeout(() => child.emit("exit", 0), 5);
    });
    setTimeout(() => {
      if (o.noUrl) {
        child.stderr.write("ERROR: (gcloud.auth.login) bad flag\n");
        child.emit("exit", 2);
        return;
      }
      child.stderr.write(`Go to the following link in your browser:\n\n    ${URL}\n\n`);
      child.stderr.write("Once finished, enter the verification code provided in your browser: ");
    }, 5);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls };
}

describe("gcloud-login chore", () => {
  it("consents in the account's profile and pipes the redirect's code to the CLI", async () => {
    const g = fakeGcloud();
    const seen: unknown[] = [];
    const browser: FlowRunner = {
      run: async (flow, input) => {
        seen.push({ site: flow.site, ...(input as object) });
        return {
          landed: "https://sdk.cloud.google.com/authcode.html?state=abc&code=4/0secret",
        } as never;
      },
    };
    const r = await gcloudLoginChore(browser, {
      account: "me@example.com",
      site: "google@me",
      spawn: g.spawn,
    });
    // The account's own profile consents, where its session lives.
    expect(seen).toEqual([{ site: "google@me", url: URL, account: "me@example.com" }]);
    expect(g.calls.args).toEqual([
      "auth",
      "login",
      "me@example.com",
      "--no-launch-browser",
      "--brief",
    ]);
    expect(g.calls.code).toBe("4/0secret\n");
    expect(r.ok).toBe(true);
    expect(r.detail).not.toContain("state=abc");
  });

  it("no URL printed: not signed in, the browser never opens", async () => {
    const g = fakeGcloud({ noUrl: true });
    let opened = false;
    const browser: FlowRunner = {
      run: async () => {
        opened = true;
        return {} as never;
      },
    };
    const r = await gcloudLoginChore(browser, { account: "me@example.com", spawn: g.spawn });
    expect(r.ok).toBe(false);
    expect(opened).toBe(false);
    expect(r.detail).toMatch(/no login URL/);
  });
});
