/**
 * Explore mode: one browser stays open on a site and takes commands one
 * at a time over loopback, so a flow can be mapped in seconds per step
 * instead of a full run per miss. Every act that succeeds is journaled
 * as a recorder `Action`, so `save` writes a recording the compiler
 * already understands. The person at the keyboard may be a model.
 *
 * The socket drives a signed-in browser, so it is loopback only and every
 * request carries the bearer token printed at start. What comes back is
 * masked like a transcript (tokens, keys) unless a command asks for raw.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, relative } from "node:path";
import type { Page } from "playwright";
import { z } from "zod";
import { defineFlow, type FlowPage, flowRunner, type RunnerOptions } from "../browser/flow.js";
import { type Hints, locate, locateAll } from "../browser/locate.js";
import { snapshotPage } from "../browser/repair.js";
import { type BrowserOptions, looksLikeWall } from "../browser/session.js";
import {
  looksLikeSecretField,
  looksLikeSecretValue,
  REDACTED,
  redactText,
} from "../recorder/redact.js";
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
  css: z.string().nullable().optional(),
  nth: z.number().int().nonnegative().nullable().optional(),
});

/** What an act points at: the same hints a flow uses (`css` and `nth` included). */
const targetSchema = z.object({ hints: hintsSchema });

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
  z.object({
    cmd: z.literal("aria"),
    hints: hintsSchema.optional(),
    limit: z.number().int().positive().optional(),
    /** Secret-shaped strings are masked unless asked for raw. */
    raw: z.boolean().optional(),
  }),
  /** Interactive elements as one line each, what the repairer sees. */
  z.object({ cmd: z.literal("snapshot"), limit: z.number().int().positive().optional() }),
  z.object({
    cmd: z.literal("text"),
    limit: z.number().int().positive().optional(),
    raw: z.boolean().optional(),
  }),
  z.object({ cmd: z.literal("url") }),
  z.object({ cmd: z.literal("screenshot") }),
  z.object({ cmd: z.literal("eval"), js: z.string(), raw: z.boolean().optional() }),
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
  /** The runner's login hook: a wall on `open` is signed through with stored credentials. */
  login?: RunnerOptions["login"];
  now?: () => number;
}

export interface Explorer {
  port: number;
  /** Every request carries this as `Authorization: Bearer …`; the socket drives a signed-in browser. */
  token: string;
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
  ...(h.css ? { css: h.css } : {}),
  ...(h.nth ? { nth: h.nth } : {}),
});

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
}

/**
 * Explore runs as one long flow: the runner owns the session, so a login
 * wall on `open` is signed through, popups are tracked, and the profile
 * is the same one the compiled flow will use.
 */
export async function startExplore(opts: ExploreOptions): Promise<Explorer> {
  const ready = new Promise<{ fp: FlowPage; finish: () => void }>((resolve) => {
    const flow = defineFlow<undefined, void>({
      site: opts.site,
      name: "explore",
      run: (fp) =>
        new Promise<void>((finish) => {
          resolve({ fp, finish });
        }),
    });
    const runner = flowRunner(opts.browser, {
      pace: null,
      ...(opts.login ? { login: opts.login } : {}),
    });
    void runner.run(flow, undefined).catch(() => undefined);
  });
  const { fp, finish: finishFlow } = await ready;
  return serve(opts, fp, finishFlow);
}

async function serve(
  opts: ExploreOptions,
  fp: FlowPage,
  finishFlow: () => void,
): Promise<Explorer> {
  const now = opts.now ?? Date.now;
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
  /** The active page: it moves when a popup opens (OAuth) and comes back after; re-read per command. */
  let page: Page = fp.page;

  const shoot = async (): Promise<string> => {
    const file = join(shotsDir, `${String(shotN++).padStart(4, "0")}.png`);
    await page.screenshot({ path: file }).catch(() => undefined);
    return file;
  };
  const journal = (a: Journaled) =>
    actions.push({ ...a, t: now() - t0, url: page.url() } as Action);

  type Target = z.infer<typeof targetSchema>;
  const find = (t: Target) => locate(page, t.hints as Hints);
  const journalAct = (t: Target, act: (target: LocatorHints) => Journaled) =>
    journal(act(toLocatorHints(t.hints)));
  /** What leaves the socket: masked like a transcript, unless the caller asks for raw. */
  const out = (text: string, raw: boolean | undefined) => (raw ? text : redactText(text));

  const run = async (c: Command): Promise<unknown> => {
    page = fp.page;
    switch (c.cmd) {
      case "open": {
        // Through the runner: a login wall is signed through, a captcha throws.
        await fp.open(c.url, { allowWall: !opts.login });
        journal({ kind: "navigate" });
        return { url: page.url(), wall: await looksLikeWall(page) };
      }
      case "click": {
        await find(c).click({ timeout: 10_000 });
        await settle(page);
        journalAct(c, (target) => ({ kind: "click", target }));
        return { url: page.url() };
      }
      case "fill": {
        await find(c).fill(c.value, { timeout: 10_000 });
        const secret =
          looksLikeSecretField(toLocatorHints(c.hints)) || looksLikeSecretValue(c.value);
        journalAct(c, (target) => ({
          kind: "input",
          target,
          value: secret ? REDACTED : c.value,
          redacted: secret,
        }));
        return { ok: true };
      }
      case "select": {
        await find(c).selectOption(c.value, { timeout: 10_000 });
        journalAct(c, (target) => ({ kind: "select", target, value: c.value }));
        return { ok: true };
      }
      case "press": {
        await find(c).press(c.key, { timeout: 10_000 });
        await settle(page);
        journalAct(c, (target) => ({ kind: "press", target, key: c.key }));
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
        const scope = c.hints ? locate(page, c.hints as Hints) : page.locator("body");
        const tree = await scope.ariaSnapshot().catch((e: Error) => `error: ${e.message}`);
        return { aria: out(tree.slice(0, c.limit ?? 12_000), c.raw) };
      }
      case "snapshot":
        return { rows: await snapshotPage(page, c.limit ?? 120) };
      case "text": {
        const text = await page
          .locator("body")
          .innerText()
          .catch(() => "");
        return { text: out(text.slice(0, c.limit ?? 4_000), c.raw) };
      }
      case "url":
        return { url: page.url() };
      case "screenshot":
        return { file: await shoot() };
      case "eval": {
        const result: unknown = await page.evaluate(c.js);
        return { result: typeof result === "string" ? out(result, c.raw) : result };
      }
      case "count":
        return { count: await locateAll(page, c.hints as Hints).count() };
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

  const token = randomBytes(16).toString("hex");
  const server: Server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401;
      res.end('{"error":"bad or missing bearer token"}');
      return;
    }
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
  page.context().on("close", () => finish());
  void done.then(() => {
    server.close();
    finishFlow();
  });
  return { port: opts.port, token, done };
}
