import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/compiler/index.js";
import { memorySink } from "../src/deps/sink.js";
import { fakeDesktop } from "../src/desktop/types.js";
import { startExplore } from "../src/explore/server.js";
import { loadRecording } from "../src/recorder/store.js";

const sink = memorySink();
const desktop = fakeDesktop([
  { role: "window", name: "General", value: null, enabled: true, depth: 0 },
  { role: "checkbox", name: "Remote Login", value: "0", enabled: true, depth: 1 },
]);

const PAGE = `data:text/html,${encodeURIComponent(
  `<label>Domain <input id="d"></label><label>Password <input type="password" id="p"></label><button id="go" onclick="document.title='clicked'">Buy now</button><p id="key">sk-ant-minted-key-1234567890abcdefghijklmnopqrstuvwxyz</p>`,
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
      desktop,
      sink,
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

    // A popup (an OAuth window) is listed and switched to; closing it returns to the main page.
    await send({ cmd: "eval", js: 'window.open("about:blank", "pop")' });
    await new Promise((r) => setTimeout(r, 500));
    const pages = (await send({ cmd: "pages" })).body.pages as Array<{ index: number }>;
    expect(pages).toHaveLength(2);
    expect((await send({ cmd: "page", index: 1 })).body).toHaveProperty("url", "about:blank");
    expect((await send({ cmd: "pages" })).body.pages).toMatchObject([
      { active: false },
      { active: true },
    ]);
    await send({ cmd: "eval", js: "window.close()" });
    await new Promise((r) => setTimeout(r, 300));
    expect((await send({ cmd: "pages" })).body.pages).toMatchObject([{ active: true }]);
    expect((await send({ cmd: "page", index: 5 })).status).toBe(500);

    const bad = await send({ cmd: "nope" });
    expect(bad.status).toBe(400);
    const noToken = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" });
    expect(noToken.status).toBe(401);
    // nth picks among matches; css is the explicit last resort
    expect((await send({ cmd: "count", hints: { role: "textbox" } })).body.count).toBe(2);
    expect(
      (await send({ cmd: "eval", js: "document.querySelector('#p').value" })).body.result,
    ).toBe("hunter2hunter2");

    // A minted secret goes to the sink; the journal and the socket never carry it.
    const kept = await send({ cmd: "keep", hints: { css: "#key" }, env: "TEST_MINTED_KEY" });
    expect(kept.body).toEqual({ env: "TEST_MINTED_KEY", length: 54 });
    expect(sink.values.TEST_MINTED_KEY).toMatch(/^sk-ant-minted-key-/);

    // Desktop acts share the session and the journal; looking is not journaled, typed secrets are hidden.
    const tree = (await send({ cmd: "os", act: { op: "tree" } })).body.tree as string;
    expect(tree).toContain('- checkbox "Remote Login": 0');
    expect(
      (await send({ cmd: "os", act: { op: "click", role: "checkbox", name: "Remote Login" } }))
        .body,
    ).toEqual({ ok: true });
    expect((await send({ cmd: "os", act: { op: "click", name: "Nope" } })).status).toBe(500);
    await send({ cmd: "os", act: { op: "type", text: "hunter2hunter2", secret: true } });
    await send({ cmd: "os", act: { op: "shell", command: "true" } });
    expect(desktop.acts.map((a) => a.op)).toEqual(["click", "type", "shell"]);

    const saved = await send({ cmd: "save", name: "buy" });
    expect(saved.body.actions).toBe(8);
    const rec = await loadRecording(join(dir, "recordings"), "buy");
    // (the page's own data: URL holds the fixture; the acts must not)
    expect(JSON.stringify(rec.actions.map(({ url: _u, ...a }) => a))).not.toContain(
      "sk-ant-minted",
    );
    expect(rec.actions.map((a) => a.kind)).toEqual([
      "navigate",
      "input",
      "input",
      "click",
      "keep",
      "desktop",
      "desktop",
      "desktop",
    ]);
    const typed = rec.actions[6];
    expect(
      typed.kind === "desktop" && typed.redacted && typed.op.op === "type" && typed.op.text,
    ).toBe("<redacted>");
    const pw = rec.actions[2];
    expect(pw.kind === "input" && pw.value).toBe("<redacted>");
    const compiled = await compile(rec);
    expect(compiled.outline.steps.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("pause: a person's hand acts land in the journal", () => {
  it("journals clicks and typing between pause and resume, nothing outside", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explore-pause-"));
    const port = 9800 + Math.floor(Math.random() * 150);
    const ex = await startExplore({
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
    });
    try {
      await ex.exec({ cmd: "open", url: PAGE });
      await ex.exec({ cmd: "pause" });
      expect(ex.paused()).toBe(true);
      // A person "clicks" and "types": real DOM events, as a hand would raise them.
      await ex.exec({
        cmd: "eval",
        js: `document.querySelector('input').focus(); document.querySelector('input').value='x.com'; document.querySelector('input').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('input').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('button').click();`,
      });
      await new Promise((r) => setTimeout(r, 300));
      const resumed = (await ex.exec({ cmd: "resume" })) as { handActs: number };
      expect(resumed.handActs).toBeGreaterThanOrEqual(1);
      const journal = (await ex.exec({ cmd: "journal" })) as { actions: Array<{ kind: string }> };
      const kinds = journal.actions.map((a) => a.kind);
      const p = kinds.indexOf("pause");
      const r = kinds.indexOf("resume");
      expect(p).toBeGreaterThan(-1);
      expect(kinds.slice(p + 1, r)).toContain("click");
    } finally {
      await ex.exec({ cmd: "close" }).catch(() => undefined);
      await ex.done;
      await new Promise((r) => setTimeout(r, 500));
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);
});
