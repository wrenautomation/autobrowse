import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ownBrowserOf, ownEndpoint, runsInOwn } from "../src/browser/own.js";
import { openSession } from "../src/browser/session.js";

describe("own browser", () => {
  it("is opt-in per site, and covers the site's accounts", () => {
    expect(ownBrowserOf("opera-gx", undefined)).toBeNull();
    expect(ownBrowserOf(undefined, "github")?.name).toBe("Chrome");
    const own = ownBrowserOf("opera-gx", "github, cloudflare");
    expect(own).toMatchObject({ name: "Opera GX", sites: ["github", "cloudflare"] });
    expect(own?.inspectUrl).toBe("opera://inspect/#remote-debugging");
    expect(runsInOwn(own, "github")).toBe(true);
    expect(runsInOwn(own, "github@wren")).toBe(true);
    expect(runsInOwn(own, "google")).toBe(false);
  });

  it("names Safari's limit instead of failing oddly", async () => {
    const own = ownBrowserOf("safari", "github");
    if (!own) throw new Error("no own browser");
    await expect(ownEndpoint(own)).rejects.toThrow(/no remote debugging/);
  });

  it("says where the switch is when debugging is off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-own-"));
    const own = ownBrowserOf(dir, "github");
    if (!own) throw new Error("no own browser");
    await expect(ownEndpoint(own)).rejects.toThrow(/Allow remote debugging/);
    writeFileSync(join(dir, "DevToolsActivePort"), "9333\n/devtools/browser/abc\n");
    expect(await ownEndpoint(own)).toBe("ws://127.0.0.1:9333/devtools/browser/abc");
  });

  let proc: ChildProcess | null = null;
  afterAll(() => {
    proc?.kill();
  });

  it("works in a tab of its own; closing leaves the browser and the person's tabs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-own-"));
    const exe = (await import("patchright")).chromium.executablePath();
    // A browser the person runs: its own data dir, debugging on, its start tab open.
    proc = spawn(
      exe,
      [`--user-data-dir=${dir}`, "--remote-debugging-port=0", "--headless=new", "--no-first-run"],
      { stdio: "ignore" },
    );
    const port = join(dir, "DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(port); i++) await new Promise((r) => setTimeout(r, 100));
    const own = ownBrowserOf(dir, "github");
    const opts = {
      tier: "local" as const,
      profilesDir: join(dir, "profiles"),
      artifactsDir: join(dir, "artifacts"),
      own,
    };
    const session = await openSession("github@wren", opts);
    expect(session.shared).toBe(true);
    await session.page.goto("about:blank#ours");
    const theirs = session.context.pages().filter((p) => p !== session.page);
    expect(theirs.length).toBeGreaterThan(0);
    await session.close();
    // Still running, their tab still there, ours gone.
    const again = await openSession("github", opts);
    const left = again.context.pages().filter((p) => p !== again.page);
    expect(left.length).toBe(theirs.length);
    expect(left.map((p) => p.url())).not.toContain("about:blank#ours");
    await again.close();
    expect(proc.exitCode).toBeNull();
  }, 60_000);
});
