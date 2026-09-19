/**
 * Explore mode: one browser stays open on a site and takes commands one
 * at a time over loopback, so a flow can be mapped in seconds per step
 * instead of a full run per miss. Every act that succeeds is journaled
 * as a recorder `Action`, so `save` writes a recording the compiler
 * already understands. The person at the keyboard may be a model.
 */
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, relative } from "node:path";
import type { Page } from "playwright";
import { z } from "zod";
import { type Hints, locateAll } from "../browser/locate.js";
import { snapshotPage } from "../browser/repair.js";
import {
  type BrowserOptions,
  looksLikeWall,
  openSession,
  type Session,
} from "../browser/session.js";
import { looksLikeSecretField, looksLikeSecretValue, REDACTED } from "../recorder/redact.js";
import { saveRecording } from "../recorder/store.js";
import type { Action, LocatorHints, Recording } from "../recorder/types.js";

const hintsSchema = z.object({
  tag: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  placeholder: z.string().nullable().optional(),
  id: z.string().nullable().optional(),
  testId: z.string().nullable().optional(),
  href: z.string().nullable().optional(),
  inputType: z.string().nullable().optional(),
});

/** A target: recorder hints (journaled as such) or a raw CSS selector (journaled as a note). */
const targetSchema = z.object({
  hints: hintsSchema.optional(),
  css: z.string().optional(),
  /** Which match when several: default first. */
  nth: z.number().int().nonnegative().optional(),
});

export const commandSchema = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("open"), url: z.string().url() }),
  targetSchema.extend({ cmd: z.literal("click"), goal: z.string().optional() }),
  targetSchema.extend({ cmd: z.literal("fill"), value: z.string(), goal: z.string().optional() }),
  targetSchema.extend({ cmd: z.literal("select"), value: z.string(), goal: z.string().optional() }),
  targetSchema.extend({ cmd: z.literal("press"), key: z.string(), goal: z.string().optional() }),
  /** Keyboard into whatever is focused; not journaled as a locator act. */
  z.object({ cmd: z.literal("type"), text: z.string() }),
  z.object({ cmd: z.literal("key"), key: z.string() }),
  /** Accessibility tree of the page (or of one locator), capped. */
  targetSchema.extend({ cmd: z.literal("aria"), limit: z.number().int().positive().optional() }),
  /** Interactive elements as one line each, what the repairer sees. */
  z.object({ cmd: z.literal("snapshot"), limit: z.number().int().positive().optional() }),
  z.object({ cmd: z.literal("text"), limit: z.number().int().positive().optional() }),
  z.object({ cmd: z.literal("url") }),
  z.object({ cmd: z.literal("screenshot") }),
  z.object({ cmd: z.literal("eval"), js: z.string() }),
  targetSchema.extend({ cmd: z.literal("count") }),
  z.object({ cmd: z.literal("note"), text: z.string() }),
  /** Write the journal as a recording under `recordingsDir/<name>`. */
  z.object({ cmd: z.literal("save"), name: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
  z.object({ cmd: z.literal("journal") }),
  z.object({ cmd: z.literal("close") }),
]);
export type Command = z.infer<typeof commandSchema>;

/** An action minus what the journal fills in, per union member. */
type Journaled = Action extends infer A ? (A extends Action ? Omit<A, "t" | "url"> : never) : never;

export interface ExploreOptions {
  site: string;
  browser: BrowserOptions;
  recordingsDir: string;
  port: number;
  now?: () => number;
}

export interface Explorer {
  port: number;
  /** Resolves when `close` arrives or the browser goes away. */
  done: Promise<void>;
}

const toLocatorHints = (h: z.infer<typeof hintsSchema>): LocatorHints => ({
  tag: h.tag ?? "",
  role: h.role ?? null,
  name: h.name ?? null,
  text: h.text ?? null,
  placeholder: h.placeholder ?? null,
  id: h.id ?? null,
  testId: h.testId ?? null,
  href: h.href ?? null,
  inputType: h.inputType ?? null,
});

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
}

export async function startExplore(opts: ExploreOptions): Promise<Explorer> {
  const now = opts.now ?? Date.now;
  const session: Session = await openSession(opts.site, opts.browser);
  const page = session.page;
  const t0 = now();
  const startedAt = new Date(t0).toISOString();
  const actions: Action[] = [];
  const shotsDir = join(opts.recordingsDir, `.explore-${opts.site}`);
  mkdirSync(shotsDir, { recursive: true });
  let shotN = 0;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const shoot = async (): Promise<string> => {
    const file = join(shotsDir, `${String(shotN++).padStart(4, "0")}.png`);
    await page.screenshot({ path: file }).catch(() => undefined);
    return file;
  };
  const journal = (a: Journaled) =>
    actions.push({ ...a, t: now() - t0, url: page.url() } as Action);

  type Target = z.infer<typeof targetSchema>;
  const find = (t: Target) => {
    if (t.css) return page.locator(t.css).nth(t.nth ?? 0);
    if (t.hints) return locateAll(page, t.hints as Hints).nth(t.nth ?? 0);
    throw new Error("give hints or css");
  };
  /** Journal an act; a CSS target has no recorder hints, so it lands as a note. */
  const journalAct = (t: Target, act: (target: LocatorHints) => Journaled, said: string) => {
    if (t.hints) journal(act(toLocatorHints(t.hints)));
    else journal({ kind: "note", text: `css ${t.css}${t.nth ? ` [${t.nth}]` : ""}: ${said}` });
  };

  const run = async (c: Command): Promise<unknown> => {
    switch (c.cmd) {
      case "open": {
        await page.goto(c.url, { waitUntil: "domcontentloaded" });
        await settle(page);
        journal({ kind: "navigate" });
        return { url: page.url(), wall: await looksLikeWall(page) };
      }
      case "click": {
        await find(c).click({ timeout: 10_000 });
        await settle(page);
        journalAct(c, (target) => ({ kind: "click", target }), "click");
        return { url: page.url() };
      }
      case "fill": {
        await find(c).fill(c.value, { timeout: 10_000 });
        const secret =
          (c.hints ? looksLikeSecretField(toLocatorHints(c.hints)) : false) ||
          looksLikeSecretValue(c.value);
        const shown = secret ? REDACTED : c.value;
        journalAct(
          c,
          (target) => ({ kind: "input", target, value: shown, redacted: secret }),
          `fill ${shown}`,
        );
        return { ok: true };
      }
      case "select": {
        await find(c).selectOption(c.value, { timeout: 10_000 });
        journalAct(
          c,
          (target) => ({ kind: "select", target, value: c.value }),
          `select ${c.value}`,
        );
        return { ok: true };
      }
      case "press": {
        await find(c).press(c.key, { timeout: 10_000 });
        await settle(page);
        journalAct(c, (target) => ({ kind: "press", target, key: c.key }), `press ${c.key}`);
        return { url: page.url() };
      }
      case "type":
        await page.keyboard.type(c.text);
        return { ok: true };
      case "key":
        await page.keyboard.press(c.key);
        await settle(page);
        return { url: page.url() };
      case "aria": {
        const scope = c.hints || c.css ? find(c) : page.locator("body");
        const tree = await scope.ariaSnapshot().catch((e: Error) => `error: ${e.message}`);
        return { aria: tree.slice(0, c.limit ?? 12_000) };
      }
      case "snapshot":
        return { rows: await snapshotPage(page, c.limit ?? 120) };
      case "text":
        return {
          text: (
            await page
              .locator("body")
              .innerText()
              .catch(() => "")
          ).slice(0, c.limit ?? 4_000),
        };
      case "url":
        return { url: page.url() };
      case "screenshot":
        return { file: await shoot() };
      case "eval":
        return { result: await page.evaluate(c.js) };
      case "count":
        return {
          count: await (c.css ? page.locator(c.css) : locateAll(page, c.hints as Hints)).count(),
        };
      case "note":
        journal({ kind: "note", text: c.text });
        return { ok: true };
      case "journal":
        return { actions };
      case "save": {
        const rec: Recording = {
          name: c.name,
          site: opts.site,
          startedAt,
          finishedAt: new Date(now()).toISOString(),
          actions: actions.map((a) =>
            a.screenshot ? { ...a, screenshot: relative(opts.recordingsDir, a.screenshot) } : a,
          ),
          trace: null,
          terminal: null,
          commands: [],
        };
        const dir = await saveRecording(opts.recordingsDir, rec);
        return { dir, actions: actions.length };
      }
      case "close":
        queueMicrotask(() => finish());
        return { ok: true };
    }
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      res.setHeader("content-type", "application/json");
      let parsed: Command;
      try {
        parsed = commandSchema.parse(JSON.parse(body || "{}"));
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      try {
        res.end(JSON.stringify(await run(parsed)));
      } catch (err) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message.split("\n")[0] : String(err),
            url: page.url(),
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
  session.context.on("close", () => finish());
  void done.then(async () => {
    server.close();
    await session.close();
  });
  return { port: opts.port, done };
}
