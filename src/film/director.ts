/**
 * `autobrowse film <tape>`: the director (designs/2026-10-24-film.md). It opens a terminal (ttyd)
 * in its own headless Chrome, films that page as the `term` pane, and types the tape with film
 * hands. The shell has `AUTOBROWSE_FILM` set, so each command it runs films its own browser into
 * the same take folder.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import {
  assertNeeds,
  filmGeometry,
  filmLog,
  filmPage,
  type Recorder,
  takePanes,
} from "../browser/film.js";
import { FILM_PACE, handsFor } from "../browser/human/index.js";
import type { Tape, TapeStep } from "./tape.js";

/** Terminal colours a viewer reads at 1x on a phone. */
const THEMES = {
  dark: { background: "#16161a", foreground: "#e8e6e1", cursor: "#e8e6e1" },
  light: { background: "#faf9f6", foreground: "#1c1b19", cursor: "#1c1b19" },
} as const;
const PAD = 40;
/** A subprocess's pane still encoding gets this long once the tape ends. */
const ENCODE_MS = 120_000;

export interface Take {
  dir: string;
  panes: string[];
}

export async function filmTape(
  tape: Tape,
  opts: { tape: string; dir: string; log?: (line: string) => void },
): Promise<Take> {
  assertNeeds(["ffmpeg", "ttyd"]);
  const say = opts.log ?? (() => {});
  const dir = resolve(opts.dir);
  const [width, height] = tape.size;
  const home = await mkdtemp(join(tmpdir(), "autobrowse-film-"));
  // A clean shell: no rc of the person's, a plain prompt, no `%` before it.
  await writeFile(
    join(home, ".zshrc"),
    ["unsetopt PROMPT_SP", "PROMPT='%F{magenta}❯%f '", "RPROMPT=''", ""].join("\n"),
  );
  const port = await freePort();
  const ttyd = spawn(
    "ttyd",
    [
      ["-p", String(port), "-i", "127.0.0.1", "-W", "-o"],
      ["-t", `fontSize=${tape.fontSize}`, "-t", "disableLeaveAlert=true"],
      [
        "-t",
        "disableResizeOverlay=true",
        "-t",
        "scrollback=10000",
        "-t",
        `theme=${JSON.stringify(THEMES[tape.theme])}`,
      ],
      ["zsh", "-i"],
    ].flat(),
    {
      cwd: tape.cwd ? resolve(tape.cwd) : process.cwd(),
      env: {
        ...process.env,
        ZDOTDIR: home,
        AUTOBROWSE_FILM: dir,
        AUTOBROWSE_FILM_SIZE: `${width}x${height}`,
      },
      stdio: "ignore",
    },
  );
  const browser = await launch({ width, height });
  let rec: Recorder | null = null;
  try {
    const page = await (await browser.newContext({ viewport: null })).newPage();
    await open(page, port, tape.theme);
    rec = await filmPage(page, dir, "term", { width, height });
    say(`filming ${dir}`);
    const hands = handsFor(FILM_PACE, Math.random, filmLog);
    await page.locator("textarea.xterm-helper-textarea").focus();
    await page.waitForTimeout(800);
    // What the terminal showed before the last key: a wait looks only past it.
    let mark = "";
    for (const step of tape.steps) mark = await play(page, hands, step, mark, say);
    await page.waitForTimeout(1_200);
    await rec.stop();
    await settled(dir);
    const panes = (await takePanes(dir)).map((p) => p.name);
    await writeFile(
      join(dir, "take.json"),
      `${JSON.stringify({ version: 1, tape: basename(opts.tape), size: tape.size, panes })}\n`,
    );
    return { dir, panes };
  } finally {
    // A tape that failed still leaves its terminal pane to look at.
    await rec?.stop().catch(() => null);
    await browser.close().catch(() => undefined);
    stop(ttyd);
    await rm(home, { recursive: true, force: true });
  }
}

/** Play one step; returns the new mark (the screen just before the last key). */
async function play(
  page: Page,
  hands: ReturnType<typeof handsFor>,
  step: TapeStep,
  mark: string,
  say: (line: string) => void,
): Promise<string> {
  if ("type" in step) {
    say(`$ ${step.type}`);
    await hands.type(page, step.type, { timeout: 60_000 });
    // Before the key: nothing has run yet, and a fast command answers before the hands let go.
    const before = await screenText(page);
    await hands.press(page, "Enter", { timeout: 5_000 });
    return before;
  }
  if ("press" in step) {
    const before = await screenText(page);
    await hands.press(page, step.press, { timeout: 5_000 });
    return before;
  }
  if ("wait" in step) {
    const until = Date.now() + step.timeoutS * 1000;
    let text = await screenText(page);
    while (!showsAnew(text, mark, step.wait)) {
      if (Date.now() > until)
        throw new Error(
          `film: the terminal did not show "${step.wait}" in ${step.timeoutS}s; it ends:\n${text.split("\n").slice(-8).join("\n")}`,
        );
      await page.waitForTimeout(200);
      text = await screenText(page);
    }
    return mark;
  }
  await page.waitForTimeout(step.sleepS * 1000);
  return mark;
}

/** Whether `text` shows `what` more often than the screen did at `mark`: output since the last key. */
export function showsAnew(text: string, mark: string, what: string): boolean {
  const count = (s: string) => s.split(what).length - 1;
  return count(text) > count(mark);
}

/** The terminal's text, scrollback and all (10000 lines: a wait counts on it). */
export function screenText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const t = (globalThis as unknown as { term?: TermLike }).term;
    if (!t) return "";
    const b = t.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
    return lines.join("\n").trimEnd();
  });
}

interface TermLike {
  buffer: {
    active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } };
  };
}

/** Load the terminal, pad it, and wait for the first prompt. */
async function open(page: Page, port: number, theme: Tape["theme"]): Promise<void> {
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      await page.goto(url);
      break;
    } catch (err) {
      if (i > 25) throw new Error(`film: ttyd did not answer on ${url}: ${String(err)}`);
      await page.waitForTimeout(200);
    }
  }
  await page.waitForFunction("window.term");
  await page.addStyleTag({
    content: `html, body { background: ${THEMES[theme].background}; }
      #terminal-container { position: absolute; inset: ${PAD}px; width: auto; height: auto; }`,
  });
  await page.evaluate("window.dispatchEvent(new Event('resize'))");
  const until = Date.now() + 10_000;
  while (!(await screenText(page)).includes("❯")) {
    if (Date.now() > until) throw new Error("film: the shell did not show its prompt");
    await page.waitForTimeout(100);
  }
}

/** Chrome itself at 2x; Playwright's bundle when no Chrome is installed. */
async function launch(size: { width: number; height: number }) {
  const { args } = filmGeometry(size);
  try {
    return await chromium.launch({ headless: true, args, channel: "chrome" });
  } catch {
    return chromium.launch({ headless: true, args });
  }
}

/** Wait until no pane in the folder is still filming or encoding. */
async function settled(dir: string): Promise<void> {
  const until = Date.now() + ENCODE_MS;
  for (;;) {
    let busy = false;
    for (const f of (await readdir(dir)).filter((n) => /^(term|web)(-\d+)?\.json$/.test(n))) {
      if ((JSON.parse(await readFile(join(dir, f), "utf8")) as { filming?: boolean }).filming)
        busy = true;
    }
    if (!busy) return;
    if (Date.now() > until) throw new Error(`film: a pane in ${dir} is still filming`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? resolvePort(a.port) : reject(new Error("port"))));
    });
  });
}

function stop(p: ChildProcess): void {
  if (p.exitCode === null) p.kill("SIGTERM");
}
