import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cfrPlan,
  FILM_FPS,
  type Frame,
  ffconcat,
  filmGeometry,
  filmSizeOf,
  holds,
  jpegSize,
  missingNeeds,
  settledFrames,
  takePanes,
} from "../src/browser/film.js";

const frame = (at: number, i: number, px: [number, number] | null = [3840, 2160]): Frame => ({
  file: `${i}.jpg`,
  at,
  px,
  view: [1920, 1080],
});

describe("film", () => {
  it("holds each frame until the next, at a constant 60 fps", () => {
    const slot = 1000 / FILM_FPS;
    const frames = [frame(1_000, 0), frame(1_000 + 3 * slot, 1), frame(1_000 + 3.5 * slot, 2)];
    expect(cfrPlan(frames, 1_000, 1_000 + 6 * slot)).toEqual([0, 0, 0, 1, 2, 2]);
  });

  it("shows the first frame from the start, even when it came late", () => {
    expect(cfrPlan([frame(1_200, 0)], 1_000, 1_100)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("drops the frames painted before the window settled, and keeps a later odd one", () => {
    const frames = [
      frame(0, 0, [3840, 1986]),
      frame(10, 1, null),
      frame(20, 2),
      frame(30, 3, [3840, 1986]),
      frame(40, 4),
    ];
    const kept = settledFrames(frames);
    expect(kept.px).toEqual([3840, 2160]);
    expect(kept.frames.map((f) => f.file)).toEqual(["2.jpg", "3.jpg", "4.jpg"]);
  });

  it("feeds ffmpeg each frame once, held its slots, the last slot its own entry", () => {
    const runs = holds([0, 0, 0, 1, 2, 2]);
    expect(runs).toEqual([
      { i: 0, n: 3 },
      { i: 1, n: 1 },
      { i: 2, n: 2 },
    ]);
    const list = ffconcat(runs, (i) => `/take/.web-1-frames/${i}.jpg`);
    const held = [...list.matchAll(/file '([^']+)'\noption framerate 60\nduration ([\d.]+)/g)].map(
      (m) => [m[1], Math.round(Number(m[2]) * FILM_FPS)],
    );
    expect(held).toEqual([
      ["/take/.web-1-frames/0.jpg", 3],
      ["/take/.web-1-frames/1.jpg", 1],
      ["/take/.web-1-frames/2.jpg", 1],
      ["/take/.web-1-frames/2.jpg", 1],
    ]);
    expect(ffconcat(holds([4]), () => "it's.jpg")).toContain("file 'it'\\''s.jpg'");
  });

  it("reads a JPEG's size from its frame header", () => {
    // SOI, an APP0 of 4 bytes, then SOF0: precision 8, height 2160, width 3840.
    const b = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x08, 0x70,
      0x0f, 0x00, 0x03,
    ]);
    expect(jpegSize(b)).toEqual([3840, 2160]);
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0x00]))).toBeNull();
  });

  it("launches Chrome itself at 2x, with no emulated viewport", () => {
    expect(filmGeometry({ width: 1920, height: 1080 })).toEqual({
      viewport: null,
      args: ["--window-size=1920,1080", "--force-device-scale-factor=2"],
    });
    expect(filmSizeOf("1080x1920")).toEqual({ width: 1080, height: 1920 });
    expect(filmSizeOf("big")).toEqual({ width: 1920, height: 1080 });
  });

  it("says how to install what is missing", () => {
    const bin = mkdtempSync(join(tmpdir(), "bin-"));
    writeFileSync(join(bin, "ttyd"), "");
    chmodSync(join(bin, "ttyd"), 0o755);
    expect(missingNeeds(["ffmpeg", "ttyd"], { PATH: bin })).toEqual([
      "ffmpeg is missing, for each pane's mp4: brew install ffmpeg (or FFMPEG=<path>)",
    ]);
    expect(missingNeeds(["ffmpeg"], { PATH: "", FFMPEG: join(bin, "ttyd") })).toEqual([]);
  });

  it("lists a take's finished panes, not the ones still filming or the take file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "take-"));
    const pane = { name: "web-1", file: "web-1.mp4", kind: "web", start: 1, end: 2 };
    writeFileSync(join(dir, "web-1.json"), JSON.stringify(pane));
    writeFileSync(join(dir, "web-2.json"), JSON.stringify({ name: "web-2", filming: true }));
    writeFileSync(join(dir, "take.json"), JSON.stringify({ version: 1 }));
    expect((await takePanes(dir)).map((p) => p.name)).toEqual(["web-1"]);
  });
});
