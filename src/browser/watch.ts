/**
 * Watching a flow: every step it takes, written down as it happens, so a
 * person can see where a site moved (a new bot check, a renamed button)
 * without running it again. Per step: what it meant to do, where it was, how
 * it went, a screenshot with every field masked, and the redacted aria tree.
 * The run's Playwright trace is kept too, success or not:
 * `npx playwright show-trace <dir>/trace.zip` replays each click. The trace
 * holds what was typed, so it stays on the machine (`shots push` skips it);
 * the shots and steps ship.
 *
 * On for the flows `WATCH_FLOWS` names: `all`, a site (`cloudflare`), or one
 * flow (`cloudflare/login`), comma separated. Off by default: a screenshot
 * per step is slow and heavy for a flow that works.
 */
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { redactAria, redactText } from "../recorder/redact.js";
import type { Hints } from "./locate.js";

export type StepKind = "open" | "act" | "captcha" | "sign-in";

export interface Step {
  n: number;
  at: string;
  kind: StepKind;
  /** In words: "open https://…", "click Purchase". */
  goal: string;
  /** The gesture (click, fill, …); a filled value is never written. */
  op?: string;
  hints?: Hints;
  /** Where the page was when the step ended. */
  url: string;
  ms: number;
  outcome: "ok" | "repaired" | "failed";
  error?: string;
  /** Files beside steps.jsonl. */
  shot?: string;
  aria?: string;
}

export interface Watch {
  readonly dir: string;
  /** Runs the step and writes it down, however it ends; a throw is rethrown. */
  step<T>(
    s: { kind: StepKind; goal: string; op?: string; hints?: Hints },
    page: () => Page,
    run: () => Promise<T>,
    /** How it went when it did not throw ("repaired" when the repairer found the control). */
    outcome?: (result: T) => Step["outcome"],
  ): Promise<T>;
}

/** Whether `WATCH_FLOWS` names this flow. */
export function watches(spec: string | undefined, site: string, name: string): boolean {
  const want = (spec ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return want.some((w) => w === "all" || w === "*" || w === site || w === `${site}/${name}`);
}

/** Every field, in every frame: a card number or a password never lands in a shot. */
const FIELDS =
  "input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, [contenteditable=''], [contenteditable=true]";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

export function watchSteps(dir: string, now: () => number = Date.now): Watch {
  mkdirSync(dir, { recursive: true });
  const ledger = join(dir, "steps.jsonl");
  let n = 0;
  const capture = async (page: Page, base: string) => {
    const got: { shot?: string; aria?: string } = {};
    const shot = `${base}.jpg`;
    const shotOk = await page
      .screenshot({
        path: join(dir, shot),
        type: "jpeg",
        quality: 60,
        timeout: 5_000,
        mask: page.frames().map((f) => f.locator(FIELDS)),
      })
      .then(
        () => true,
        () => false,
      );
    if (shotOk) got.shot = shot;
    const tree = await page
      .locator("body")
      .ariaSnapshot({ timeout: 5_000 })
      .catch(() => null);
    if (tree !== null) {
      got.aria = `${base}.aria.txt`;
      writeFileSync(join(dir, got.aria), redactAria(`${page.url()}\n\n${tree}`));
    }
    return got;
  };
  return {
    dir,
    async step(s, page, run, outcome) {
      const k = ++n;
      const started = now();
      const write = async (o: Step["outcome"], error?: unknown) => {
        const p = page();
        const base = `${String(k).padStart(3, "0")}-${s.kind}-${slug(s.goal)}`;
        const files = await capture(p, base).catch(() => ({}));
        const step: Step = {
          n: k,
          at: new Date(started).toISOString(),
          ...s,
          url: redactText(p.url()),
          ms: now() - started,
          outcome: o,
          ...(error === undefined
            ? {}
            : {
                error: redactText(error instanceof Error ? error.message : String(error)).slice(
                  0,
                  500,
                ),
              }),
          ...files,
        };
        appendFileSync(ledger, `${JSON.stringify(step)}\n`);
      };
      try {
        const result = await run();
        await write(outcome ? outcome(result) : "ok");
        return result;
      } catch (err) {
        await write("failed", err);
        throw err;
      }
    },
  };
}

/** The steps a watched run wrote, in order. */
export function readSteps(dir: string): Step[] {
  const file = join(dir, "steps.jsonl");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Step);
}

/** Watched runs under the artifacts dir, newest first (each is a folder with steps.jsonl). */
export function watchedRuns(artifactsDir: string): string[] {
  const dirs = (() => {
    try {
      return readdirSync(artifactsDir, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  return dirs
    .filter((d) => d.isDirectory())
    .map((d) => join(artifactsDir, d.name))
    .filter((d) => {
      try {
        return statSync(join(d, "steps.jsonl")).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}
