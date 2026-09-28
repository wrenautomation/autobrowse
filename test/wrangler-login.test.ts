import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { FlowRunner } from "../src/browser/flow.js";
import { wranglerLoginChore } from "../src/chores/wrangler-login.js";

const URL = "https://dash.cloudflare.com/oauth2/auth?response_type=code&state=abc";

/** A stand-in `wrangler login`: prints the URL, exits once the browser "authorized". */
function fakeWrangler(o: { noUrl?: boolean } = {}) {
  const calls = { args: [] as string[], env: {} as NodeJS.ProcessEnv };
  const authorized = { fire: () => {} };
  const spawn = ((_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    calls.args = args;
    calls.env = opts.env;
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    setTimeout(() => {
      if (o.noUrl) {
        child.stdout.write("You are logged in with an API Token\n");
        child.emit("exit", 1);
        return;
      }
      child.stdout.write(`Visit this link to authenticate: ${URL}\n`);
    }, 5);
    authorized.fire = () => {
      child.stdout.write("Successfully logged in.\n");
      setTimeout(() => child.emit("exit", 0), 5);
    };
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls, authorized };
}

describe("wrangler-login chore", () => {
  it("authorizes the printed URL in the browser; the CLI keeps its token", async () => {
    const w = fakeWrangler();
    const seen: string[] = [];
    const browser: FlowRunner = {
      run: async (_flow, input) => {
        seen.push((input as { url: string }).url);
        w.authorized.fire();
        return { granted: true } as never;
      },
    };
    process.env.CLOUDFLARE_API_TOKEN = "t";
    const r = await wranglerLoginChore(browser, { spawn: w.spawn, scopes: ["account:read"] });
    delete process.env.CLOUDFLARE_API_TOKEN;
    expect(seen).toEqual([URL]);
    expect(w.calls.args).toEqual([
      "-y",
      "wrangler",
      "login",
      "--browser=false",
      "--scopes",
      "account:read",
    ]);
    // An API token would make wrangler skip OAuth.
    expect(w.calls.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.detail).not.toContain("state=abc");
  });

  it("no URL printed: not signed in, the browser never opens", async () => {
    const w = fakeWrangler({ noUrl: true });
    let opened = false;
    const browser: FlowRunner = {
      run: async () => {
        opened = true;
        return {} as never;
      },
    };
    const r = await wranglerLoginChore(browser, { spawn: w.spawn, urlMs: 2_000 });
    expect(r.ok).toBe(false);
    expect(opened).toBe(false);
    expect(r.detail).toMatch(/no login URL/);
  });
});
