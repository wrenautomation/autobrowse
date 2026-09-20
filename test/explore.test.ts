import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/compiler/index.js";
import { startExplore } from "../src/explore/server.js";
import { loadRecording } from "../src/recorder/store.js";

const PAGE = `data:text/html,${encodeURIComponent(
  `<label>Domain <input id="d"></label><label>Password <input type="password" id="p"></label><button id="go" onclick="document.title='clicked'">Buy now</button>`,
)}`;

describe("explore mode", () => {
  let dir: string;
  let port: number;
  let done: Promise<void>;
  let token: string;
  const send = async (cmd: Record<string, unknown>) => {
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(cmd),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "explore-"));
    port = 9300 + Math.floor(Math.random() * 500);
    ({ done, token } = await startExplore({
      site: "scratch",
      port,
      recordingsDir: join(dir, "recordings"),
      browser: {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
    }));
  }, 30_000);
  afterAll(async () => {
    await send({ cmd: "close" }).catch(() => undefined);
    await done;
    await new Promise((r) => setTimeout(r, 500)); // Chrome still flushes its profile
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("takes commands one at a time, journals the ones that work, and saves a compilable recording", async () => {
    const opened = await send({ cmd: "open", url: PAGE });
    expect(opened.body, JSON.stringify(opened.body)).toHaveProperty("url", PAGE);
    const aria = (await send({ cmd: "aria" })).body.aria as string;
    expect(aria).toContain('button "Buy now"');
    expect(aria).toContain('textbox "Domain"');

    const miss = await send({ cmd: "click", hints: { role: "button", name: "Purchase" } });
    expect(miss.status).toBe(500);
    expect(miss.body.error).toMatch(/timeout|Timeout/);

    await send({ cmd: "fill", hints: { role: "textbox", name: "Domain" }, value: "x.com" });
    await send({
      cmd: "fill",
      hints: { role: "textbox", name: "Password" },
      value: "hunter2hunter2",
    });
    await send({ cmd: "click", hints: { role: "button", name: "Buy now" } });
    expect((await send({ cmd: "eval", js: "document.title" })).body.result).toBe("clicked");

    const bad = await send({ cmd: "nope" });
    expect(bad.status).toBe(400);
    const noToken = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" });
    expect(noToken.status).toBe(401);
    // nth picks among matches; css is the explicit last resort
    expect((await send({ cmd: "count", hints: { role: "textbox" } })).body.count).toBe(2);
    expect(
      (await send({ cmd: "eval", js: "document.querySelector('#p').value" })).body.result,
    ).toBe("hunter2hunter2");

    const saved = await send({ cmd: "save", name: "buy" });
    expect(saved.body.actions).toBe(4);
    const rec = await loadRecording(join(dir, "recordings"), "buy");
    expect(rec.actions.map((a) => a.kind)).toEqual(["navigate", "input", "input", "click"]);
    const pw = rec.actions[2];
    expect(pw.kind === "input" && pw.value).toBe("<redacted>");
    const compiled = await compile(rec);
    expect(compiled.outline.steps.length).toBeGreaterThan(0);
  }, 60_000);
});
