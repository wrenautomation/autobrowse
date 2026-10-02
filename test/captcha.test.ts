import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import {
  findCaptcha,
  parseCanvasMove,
  parseSquares,
  solveCaptcha,
} from "../src/browser/captcha/index.js";
import type { Hands } from "../src/browser/human/index.js";

/** A page (its main frame, or a frame inside it) where only selectors containing one of `shown` are visible. */
function pageShowing(...shown: string[]): Page {
  const loc = (sel: string) => ({
    first: () => ({
      isVisible: async () => shown.some((s) => sel.includes(s)),
      contentFrame: () => ({ locator: () => ({}) }),
    }),
  });
  const frame = { url: () => "https://example.com/", locator: loc };
  return {
    locator: loc,
    frames: () => [frame],
    waitForTimeout: async () => undefined,
  } as unknown as Page;
}
const hands = {} as Hands;

describe("captcha", () => {
  it("reads the squares the eyes name, in range, once each", () => {
    expect(parseSquares('sure: {"squares":[1, 3, 3, "5", 12]}', 9)).toEqual([1, 3, 5]);
    expect(parseSquares('{"squares":[]}', 9)).toEqual([]);
    expect(parseSquares("no idea", 9)).toBeNull();
    expect(parseSquares('{"tiles":[1]}', 9)).toBeNull();
  });

  it("finds Turnstile in a closed shadow root by the frame list", async () => {
    const frame = {
      url: () => "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x",
      locator: pageShowing().locator,
      frameElement: async () => ({
        boundingBox: async () => ({ x: 192, y: 304, width: 300, height: 65 }),
      }),
    };
    const page = { ...pageShowing(), frames: () => [frame] } as unknown as Page;
    expect(await findCaptcha(page)).toEqual({ kind: "checkbox", vendor: "turnstile" });
  });

  it("finds a widget nested in another site's iframe", async () => {
    const outer = { url: () => "https://www.facebook.com/", locator: pageShowing().locator };
    const nested = {
      url: () => "https://www.fbsbx.com/captcha/recaptcha/iframe/",
      locator: pageShowing("recaptcha/enterprise/anchor").locator,
    };
    const page = { ...pageShowing(), frames: () => [outer, nested] } as unknown as Page;
    expect(await findCaptcha(page)).toEqual({ kind: "checkbox", vendor: "recaptcha" });
  });

  it("an open challenge is what is asked, before its checkbox", async () => {
    expect(
      await findCaptcha(pageShowing("recaptcha/api2/bframe", "recaptcha/api2/anchor")),
    ).toEqual({ kind: "grid", vendor: "recaptcha" });
    expect(await findCaptcha(pageShowing("challenges.cloudflare.com"))).toEqual({
      kind: "checkbox",
      vendor: "turnstile",
    });
    expect(await findCaptcha(pageShowing())).toBeNull();
  });

  it("without eyes a picture captcha is a person's; no captcha is not solved", async () => {
    const grid = await solveCaptcha(pageShowing("hcaptcha.com"), { hands, settleMs: 1 });
    expect(grid).toMatchObject({ solved: false, kind: "grid", vendor: "hcaptcha" });
    expect(grid.solved ? "" : grid.reason).toMatch(/needs eyes/);
    expect(await solveCaptcha(pageShowing(), { hands })).toMatchObject({
      solved: false,
      reason: "no captcha on the page",
    });
  });

  it("a hand or eye that throws comes back as the reason, not a crash", async () => {
    const page = pageShowing("recaptcha/api2/anchor");
    const clumsy = {
      think: async () => undefined,
      click: async () => {
        throw new Error("the box moved\nstack");
      },
    } as unknown as Hands;
    expect(await solveCaptcha(page, { hands: clumsy })).toEqual({
      solved: false,
      kind: "checkbox",
      vendor: "recaptcha",
      reason: "the box moved",
    });
  });
});

describe("parseCanvasMove", () => {
  it("reads clicks and drags in picture pixels as CSS points", () => {
    expect(parseCanvasMove('{"clicks":[[100,40],[20,20]]}', 2, 200, 200)).toEqual({
      clicks: [
        { x: 50, y: 20 },
        { x: 10, y: 10 },
      ],
    });
    expect(parseCanvasMove('ok {"drag":{"from":[10,10],"to":[300,200]}}', 2, 200, 200)).toEqual({
      drag: { from: { x: 5, y: 5 }, to: { x: 150, y: 100 } },
    });
  });
  it("skips when unsure, refuses points outside the picture or nonsense", () => {
    expect(parseCanvasMove('{"skip":true}', 1, 100, 100)).toEqual({ skip: true });
    expect(parseCanvasMove('{"clicks":[[500,5]]}', 1, 100, 100)).toBeNull();
    expect(parseCanvasMove('{"clicks":[]}', 1, 100, 100)).toBeNull();
    expect(parseCanvasMove("no idea", 1, 100, 100)).toBeNull();
  });
});
