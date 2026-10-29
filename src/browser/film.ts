/**
 * Film: a browser session that records itself as a take (designs/2026-10-24-film.md).
 *
 * Each page is a pane: its screencast frames (sharp at 2x) and every act the
 * hands did on it (`HandsLog`), on one clock, epoch ms. When the page or the
 * session closes, ffmpeg makes `<pane>.mp4`: each frame once, held until the
 * next, on a 1/60 s clock; `<pane>.json` says the rest. The cursor
 * is not filmed: an editor draws it from the log.
 *
 * Panes from several processes share a take folder (a tape's terminal and
 * each command it typed), so each pane claims its own name with an exclusive
 * create, and no file is written by two.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { HandEvent, HandsLog } from "./human/index.js";

export interface FilmOptions {
  /** The take folder. */
  dir: string;
  /** The page, CSS px. */
  size: { width: number; height: number };
}

/** Frames at this many device px per CSS px: a 1.8x zoom stays sharp. */
export const FILM_SCALE = 2;
export const FILM_SIZE = { width: 1920, height: 1080 };
/** Every pane's mp4 keeps time in slots of 1/this s, whatever rate the page painted at. */
export const FILM_FPS = 60;

/** A flow step's overlay row, at its start; an editor draws the overlay from these. */
export interface StepEvent {
  kind: "step";
  t: number;
  cmd: string;
  what: string;
  ok: boolean;
  ms: number;
  note: string;
}

export type PaneEvent = HandEvent | { kind: "load"; t: number; url: string } | StepEvent;

export interface Pane {
  name: string;
  /** The mp4, beside this file. */
  file: string;
  kind: "web" | "term";
  /** Epoch ms: the video's first frame shows at `start`. */
  start: number;
  end: number;
  /** CSS px of the page; points in `events` are in these. */
  size: [number, number];
  /** Video px per CSS px. */
  scale: number;
  /** `t` is ms from `start`. */
  events: PaneEvent[];
}

/** A tool filming runs, and how to get it. */
export interface Need {
  bin: string;
  for: string;
  install: string;
}

export const FILM_NEEDS: readonly Need[] = [
  { bin: "ffmpeg", for: "each pane's mp4", install: "brew install ffmpeg (or FFMPEG=<path>)" },
  { bin: "ttyd", for: "a tape's terminal pane", install: "brew install ttyd" },
];

/** `FFMPEG`, else `ffmpeg` on the PATH. */
export const ffmpegBin = (env = process.env) => env.FFMPEG || "ffmpeg";

/** Whether a binary runs: a path that is executable, or a name on the PATH. */
export function onPath(bin: string, env = process.env): boolean {
  const runs = (p: string) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (bin.includes("/")) return runs(bin);
  return (env.PATH ?? "").split(delimiter).some((d) => d && runs(join(d, bin)));
}

/** The needs that are missing, as lines to print; empty when all are there. */
export function missingNeeds(bins: readonly string[], env = process.env): string[] {
  return FILM_NEEDS.filter((n) => bins.includes(n.bin))
    .filter((n) => !onPath(n.bin === "ffmpeg" ? ffmpegBin(env) : n.bin, env))
    .map((n) => `${n.bin} is missing, for ${n.for}: ${n.install}`);
}

export function assertNeeds(bins: readonly string[], env = process.env): void {
  const missing = missingNeeds(bins, env);
  if (missing.length) throw new Error(`film: ${missing.join("; ")}`);
}

/** Launch geometry for a filmed local browser: no emulated viewport, Chrome itself at 2x. */
export function filmGeometry(size: FilmOptions["size"]) {
  return {
    viewport: null,
    args: [
      `--window-size=${size.width},${size.height}`,
      `--force-device-scale-factor=${FILM_SCALE}`,
    ],
  };
}

/** `1920x1080` → a size; anything else is the default. */
export function filmSizeOf(s: string | undefined): FilmOptions["size"] {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(s ?? "");
  return m ? { width: Number(m[1]), height: Number(m[2]) } : FILM_SIZE;
}

/** The page each pane films: the hands' log goes to it. */
const filming = new WeakMap<Page, Recorder>();

/** The hands' log for every filmed page; a page no one films drops it. */
export const filmLog: HandsLog = (page, e) => filming.get(page)?.note(e);
/** A step's row into the page's film; no-op when unfilmed. */
export const filmStep = (page: Page, e: StepEvent) => filming.get(page)?.note(e);

/** The first free `<kind>-<n>.json` in the folder, claimed. Names: `term`, `web-1`, `web-2`. */
async function claim(dir: string, kind: Pane["kind"], start: number): Promise<string> {
  for (let n = 1; n < 1_000; n++) {
    const name = kind === "term" && n === 1 ? "term" : `${kind}-${n}`;
    try {
      const f = await open(join(dir, `${name}.json`), "wx");
      await f.writeFile(JSON.stringify({ name, kind, start, filming: true }));
      await f.close();
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`film: no free ${kind} pane name in ${dir}`);
}

/** A JPEG's pixel size, from its frame header. */
export function jpegSize(b: Buffer): [number, number] | null {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] as number;
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15 carry the size; C4 (DHT), C8 and CC are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  return null;
}

export interface Frame {
  file: string;
  at: number;
  /** Device px of the JPEG; null when its header did not say. */
  px: [number, number] | null;
  /** CSS px of the page it shows. */
  view: [number, number];
}

/**
 * The frames a pane keeps, and their size: the last frame's. Frames of another size before the
 * first frame of that size go: the window was still settling (`fitWindow`). A later odd one stays,
 * fitted into the size.
 */
export function settledFrames(frames: readonly Frame[]): {
  frames: Frame[];
  px: [number, number] | null;
} {
  const px = frames.findLast((f) => f.px)?.px ?? null;
  if (!px) return { frames: [...frames], px };
  const same = (f: Frame) => f.px?.[0] === px[0] && f.px?.[1] === px[1];
  return { frames: frames.slice(frames.findIndex(same)), px };
}

/**
 * Which frame each 1/60 s of the video shows, for frames that came only when
 * the page changed: the latest one painted by then, the first from `start`,
 * the last until `end`.
 *
 */
export function cfrPlan(frames: readonly Frame[], start: number, end: number): number[] {
  const slots = Math.max(1, Math.ceil(((end - start) * FILM_FPS) / 1000));
  const plan: number[] = [];
  let i = 0;
  for (let k = 0; k < slots; k++) {
    const at = start + (k * 1000) / FILM_FPS;
    while (i + 1 < frames.length && (frames[i + 1] as Frame).at <= at) i++;
    plan.push(i);
  }
  return plan;
}

export interface Recorder {
  readonly name: string;
  note(e: PaneEvent): void;
  /** Stop, encode, write the pane; the frames go. Null when the page never painted. */
  stop(): Promise<Pane | null>;
}

/** Film one page as a pane of the take; `size` is the page it should be. */
export async function filmPage(
  page: Page,
  dir: string,
  kind: Pane["kind"] = "web",
  size: FilmOptions["size"] = FILM_SIZE,
): Promise<Recorder> {
  await mkdir(dir, { recursive: true });
  await fitWindow(page, size).catch(() => undefined);
  const start = Date.now();
  const name = await claim(dir, kind, start);
  const framesDir = join(dir, `.${name}-frames`);
  await mkdir(framesDir, { recursive: true });
  const frames: Frame[] = [];
  const writes = new Set<Promise<void>>();
  const events: PaneEvent[] = [];
  const view0 = await innerSize(page).catch((): [number, number] => [size.width, size.height]);
  await page.screencast.start({
    size: { width: view0[0] * FILM_SCALE, height: view0[1] * FILM_SCALE },
    quality: 90,
    onFrame: ({ data, timestamp, viewportWidth, viewportHeight }) => {
      const file = `${String(frames.length).padStart(6, "0")}.jpg`;
      frames.push({
        file,
        at: timestamp,
        px: jpegSize(data),
        view: [viewportWidth, viewportHeight],
      });
      const w = writeFile(join(framesDir, file), data).finally(() => writes.delete(w));
      writes.add(w);
    },
  });
  const onNav = (frame: ReturnType<Page["mainFrame"]>) => {
    if (frame === page.mainFrame()) rec.note({ kind: "load", t: Date.now(), url: frame.url() });
  };
  page.on("framenavigated", onNav);
  let stopped: Promise<Pane | null> | null = null;
  const rec: Recorder = {
    name,
    note(e) {
      if (!stopped) events.push({ ...e, t: e.t - start } as PaneEvent);
    },
    stop() {
      stopped ??= (async () => {
        const end = Date.now();
        filming.delete(page);
        page.off("framenavigated", onNav);
        await page.screencast.stop().catch(() => undefined);
        await Promise.all([...writes]);
        const kept = settledFrames(frames);
        const last = kept.frames.at(-1);
        if (!last) {
          await rm(join(dir, `${name}.json`), { force: true });
          await rm(framesDir, { recursive: true, force: true });
          return null;
        }
        const file = `${name}.mp4`;
        const [w, h] = last.view;
        const px = kept.px ?? [w, h];
        await encode(
          cfrPlan(kept.frames, start, end),
          (i) => join(framesDir, (kept.frames[i] as Frame).file),
          px,
          join(dir, file),
        );
        const pane: Pane = {
          name,
          file,
          kind,
          start,
          end,
          size: [w, h],
          scale: px[0] / w,
          events,
        };
        const tmp = join(dir, `.${name}.json`);
        await writeFile(tmp, `${JSON.stringify(pane)}\n`);
        await rename(tmp, join(dir, `${name}.json`));
        await rm(framesDir, { recursive: true, force: true });
        return pane;
      })();
      return stopped;
    },
  };
  filming.set(page, rec);
  page.once("close", () => void rec.stop());
  return rec;
}

const innerSize = (page: Page) => page.evaluate<[number, number]>("[innerWidth, innerHeight]");

/**
 * Grow the window until the page is `size`. `--window-size` counts the window's own frame in
 * Chrome (not in Playwright's bundle), so a 1920x1080 window holds a 1920x993 page.
 */
async function fitWindow(page: Page, size: FilmOptions["size"]): Promise<void> {
  const [w, h] = await innerSize(page);
  if (w === size.width && h === size.height) return;
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        width: (bounds.width ?? w) + size.width - w,
        height: (bounds.height ?? h) + size.height - h,
      },
    });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  for (let i = 0; i < 20; i++) {
    const [w2, h2] = await innerSize(page);
    if (w2 === size.width && h2 === size.height) return;
    await page.waitForTimeout(50);
  }
}

/** A plan as runs: frame `i` held for `n` slots. */
export function holds(plan: readonly number[]): { i: number; n: number }[] {
  const runs: { i: number; n: number }[] = [];
  for (const i of plan) {
    const last = runs.at(-1);
    if (last?.i === i) last.n++;
    else runs.push({ i, n: 1 });
  }
  return runs;
}

/**
 * The runs as an ffconcat list: each JPEG once, held its slots. `framerate 60` puts the image
 * demuxer on the 1/60 s clock (its default 1/25 s rounds each hold). Concat drops the last
 * entry's duration, so the last slot is its own entry, and the video ends on the plan's last slot.
 */
export function ffconcat(runs: readonly { i: number; n: number }[], fileOf: (i: number) => string) {
  const quote = (f: string) => `'${f.replaceAll("'", "'\\''")}'`;
  const entry = (i: number, n: number) =>
    `file ${quote(fileOf(i))}\noption framerate ${FILM_FPS}\nduration ${(n / FILM_FPS).toFixed(6)}\n`;
  const last = runs.at(-1);
  if (!last) return "ffconcat version 1.0\n";
  const body = [
    ...runs.slice(0, -1).map((r) => entry(r.i, r.n)),
    last.n > 1 ? entry(last.i, last.n - 1) : "",
  ];
  return `ffconcat version 1.0\n${body.join("")}${entry(last.i, 1)}`;
}

/** Every frame at w x h: an odd one fitted inside, centred. */
const fitInto = (w: number, h: number) =>
  `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;

/** A plan's frames as an mp4 a browser and an editor both play: H.264, on the 1/60 s clock, even sides. */
async function encode(
  plan: readonly number[],
  fileOf: (i: number) => string,
  px: [number, number],
  out: string,
) {
  const [w, h] = [px[0] & ~1, px[1] & ~1];
  const list = `${out}.ffconcat`;
  await writeFile(list, ffconcat(holds(plan), fileOf));
  const ff = spawn(
    ffmpegBin(),
    [
      ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list],
      // Only the frames the page painted, each on its 1/60 s slot: a still page costs nothing.
      ["-fps_mode", "vfr", "-vf", fitInto(w, h)],
      // No B-frames: with them a held frame's dts runs ahead, and the mp4 comes out short.
      ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-bf", "0"],
      ["-video_track_timescale", "60000"],
      ["-movflags", "+faststart", out],
    ].flat(),
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let said = "";
  ff.stderr.on("data", (b: Buffer) => {
    said = (said + b.toString()).slice(-2_000);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    ff.on("error", reject);
    ff.on("close", resolve);
  });
  await rm(list, { force: true });
  if (code !== 0)
    throw new Error(`film: ffmpeg failed for ${out}: ${said.trim() || `exit ${code}`}`);
}

/** Film every page a context opens, now and later; `stop` ends them all. */
export async function filmContext(
  context: BrowserContext,
  film: FilmOptions,
): Promise<{ stop(): Promise<void> }> {
  assertNeeds(["ffmpeg"]);
  const recs: Promise<Recorder | null>[] = [];
  const add = (page: Page) => {
    const rec = filmPage(page, film.dir, "web", film.size).catch(() => null);
    recs.push(rec);
    return rec;
  };
  // The first pages film before the session is handed out: nothing else claims their screencast.
  await Promise.all(context.pages().map(add));
  context.on("page", add);
  return {
    async stop() {
      context.off("page", add);
      const all = await Promise.all(recs);
      await Promise.all(all.map((r) => r?.stop()));
    },
  };
}

/** A take folder's finished panes, by name; still-filming claims are left out. */
export async function takePanes(dir: string): Promise<Pane[]> {
  if (!existsSync(dir)) return [];
  const panes: Pane[] = [];
  for (const f of (await readdir(dir)).filter((n) => /^(term|web)(-\d+)?\.json$/.test(n)).sort()) {
    const p = JSON.parse(await readFile(join(dir, f), "utf8")) as Pane & { filming?: boolean };
    if (!p.filming && p.name) panes.push(p);
  }
  return panes;
}
