import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { recorderControl, startBrowserRecording } from "../src/recorder/browser.js";
import {
  looksLikeSecretField,
  looksLikeSecretValue,
  redactAria,
  redactText,
} from "../src/recorder/redact.js";
import { listRecordingSummaries, listRecordings, saveRecording } from "../src/recorder/store.js";
import { extractCommands, scriptArgs, stripAnsi } from "../src/recorder/terminal.js";
import type { Recording } from "../src/recorder/types.js";

describe("redact", () => {
  it("knows secret fields and secret-shaped values", () => {
    expect(looksLikeSecretField({ inputType: "password" })).toBe(true);
    expect(looksLikeSecretField({ name: "API token" })).toBe(true);
    expect(looksLikeSecretField({ name: "Domain name" })).toBe(false);
    expect(looksLikeSecretValue("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(looksLikeSecretValue("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(true);
    expect(looksLikeSecretValue("wren-six.com")).toBe(false);
    expect(redactText("export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 && echo ok")).toBe(
      "export TOKEN=<redacted> && echo ok",
    );
  });
});

describe("terminal", () => {
  it("picks platform script flags and pulls commands out of a transcript", () => {
    expect(scriptArgs("darwin", "f.log", "/bin/zsh")).toEqual(["-q", "f.log", "/bin/zsh"]);
    expect(scriptArgs("linux", "f.log", "/bin/bash")).toEqual(["-q", "-c", "/bin/bash", "f.log"]);
    const t = stripAnsi(
      "\u001b[32mme@mac\u001b[0m % gh auth login\r\nok\nme@mac % aws sso login\nme@mac % exit\n",
    );
    expect(extractCommands(t)).toEqual(["gh auth login", "aws sso login"]);
  });
});

describe("store", () => {
  it("round-trips a manifest and lists newest first", async () => {
    const root = await mkdtemp(join(tmpdir(), "rec-"));
    const base: Recording = {
      name: "a",
      site: "scratch",
      startedAt: "2026-09-19T10:00:00Z",
      finishedAt: "2026-09-19T10:01:00Z",
      actions: [],
      trace: null,
      terminal: null,
      commands: [],
    };
    await saveRecording(root, base);
    await saveRecording(root, { ...base, name: "b", startedAt: "2026-09-19T11:00:00Z" });
    expect((await listRecordings(root)).map((r) => r.name)).toEqual(["b", "a"]);
    await expect(saveRecording(root, { ...base, name: "Bad Name" })).rejects.toThrow(/kebab/);
  });
  it("lists from summaries, and writes one for a recording saved without", async () => {
    const root = await mkdtemp(join(tmpdir(), "rec-"));
    const rec: Recording = {
      name: "old",
      site: "scratch",
      startedAt: "2026-09-19T10:00:00Z",
      finishedAt: "2026-09-19T10:01:00Z",
      actions: [
        {
          kind: "click",
          at: "2026-09-19T10:00:30Z",
          target: { role: "button", name: "Go" },
        } as never,
      ],
      trace: null,
      terminal: null,
      commands: ["ls"],
    };
    await saveRecording(root, rec);
    await rm(join(root, "old", "summary.json"));
    const rows = await listRecordingSummaries(root);
    expect(rows).toEqual([
      {
        name: "old",
        site: "scratch",
        startedAt: rec.startedAt,
        finishedAt: rec.finishedAt,
        actionCount: 1,
        commandCount: 1,
      },
    ]);
    expect(existsSync(join(root, "old", "summary.json"))).toBe(true);
  });
});

describe("recordBrowser", () => {
  it("masks credentials carried in a URL and a field named DSN", () => {
    expect(
      redactText("dsn https://b8c5df178ddbca3691ff56840302e317@o451.ingest.us.sentry.io/4512"),
    ).toBe("dsn https://<redacted>@o451.ingest.us.sentry.io/4512");
    expect(redactText("postgres://wren:hunter2pass@db.internal:5432/wren")).toBe(
      "postgres://<redacted>@db.internal:5432/wren",
    );
    expect(redactAria('- textbox "DSN URL": https://x.y/1')).toBe(
      '- textbox "DSN URL": <redacted>',
    );
  });

  it("masks a filled password field in an aria tree, whatever the value looks like", () => {
    const tree = [
      "- main:",
      '  - textbox "Enter your password": b+f9ZmBWyevCyMn6=2PdHoqq',
      '  - textbox "Domain": wren-six.com',
      '  - textbox "Show password"',
      '  - checkbox "Show password"',
    ].join("\n");
    expect(redactAria(tree)).toBe(
      [
        "- main:",
        '  - textbox "Enter your password": <redacted>',
        '  - textbox "Domain": wren-six.com',
        '  - textbox "Show password"',
        '  - checkbox "Show password"',
      ].join("\n"),
    );
  });

  it("captures clicks, inputs (redacted when secret), navigations, pause and notes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rec-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    const control = recorderControl();
    let t = 0;
    const active = await startBrowserRecording({
      session: { context, page, close: async () => undefined },
      dir,
      startUrl: null,
      control,
      now: () => (t += 100),
    });
    await page.goto(
      `data:text/html,${encodeURIComponent(
        `<form><label>Domain <input id="d" name="domain"></label>
         <input type="password" id="p" aria-label="Password">
         <button type="button" id="go">Buy now</button></form>`,
      )}`,
    );
    await page.fill("#d", "wren-six.com");
    await page.fill("#p", "hunter2");
    await page.press("#p", "Tab");
    control.note("about to buy");
    control.pause();
    await page.click("#go");
    control.play();
    await page.click("#go");
    await page.waitForTimeout(200);
    control.stop();
    const rec = await active.finished;
    await browser.close();
    const kinds = rec.actions.map((a) => a.kind);
    expect(kinds).toContain("navigate");
    const input = rec.actions.find((a) => a.kind === "input" && a.target.name === "Domain");
    expect(input).toMatchObject({ value: "wren-six.com", redacted: false });
    const pw = rec.actions.find((a) => a.kind === "input" && a.target.inputType === "password");
    expect(pw).toMatchObject({ value: "<redacted>", redacted: true });
    expect(rec.actions.find((a) => a.kind === "note")).toMatchObject({ text: "about to buy" });
    // Paused click dropped; markers written; the click after play captured with a screenshot.
    const clicks = rec.actions.filter((a) => a.kind === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ target: { role: "button", name: "Buy now", id: "go" } });
    expect(clicks[0]?.screenshot).toMatch(/^screenshots\/\d{4}\.png$/);
    expect(kinds.indexOf("pause")).toBeLessThan(kinds.indexOf("resume"));
    expect(await readFile(join(dir, clicks[0]?.screenshot ?? ""))).toBeTruthy();
    expect(rec.trace).toBe("trace.zip");
  });
});
