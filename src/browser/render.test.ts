import { describe, expect, it } from "vitest";
import type { CaptchaOutcome } from "./captcha/index.js";
import { looksWalled, type RenderedPage, solveWall } from "./render.js";

const page = (html: string, status = 200): RenderedPage => ({
  finalUrl: "https://x.test/",
  status,
  type: "text/html",
  html,
});
const words = `<html><body><p>${"A real page with words. ".repeat(120)}</p></body></html>`;
const wall = page("<html><title>Prove your humanity</title><body>checking</body></html>", 403);
const solved: CaptchaOutcome = { solved: true, kind: "checkbox", vendor: "turnstile", rounds: 1 };
const none: CaptchaOutcome = {
  solved: false,
  kind: null,
  vendor: null,
  reason: "no captcha on the page",
};
const blind: CaptchaOutcome = {
  solved: false,
  kind: "grid",
  vendor: "recaptcha",
  reason: "a grid captcha needs eyes (a model that sees)",
};
const failed: CaptchaOutcome = {
  solved: false,
  kind: "checkbox",
  vendor: "turnstile",
  reason: "still there",
};
const noSleep = async () => {};

describe("the render rung's captcha step", () => {
  it("leaves a page with words alone", async () => {
    let tries = 0;
    const got = await solveWall(
      page(words),
      async () => page(words),
      async () => {
        tries++;
        return solved;
      },
      3,
      noSleep,
    );
    expect(looksWalled(page(words))).toBe(false);
    expect(tries).toBe(0);
    expect(got.html).toBe(page(words).html);
  });

  it("solves a wall and reads the page behind it", async () => {
    const got = await solveWall(
      wall,
      async () => page(words),
      async () => solved,
      3,
      noSleep,
    );
    expect(got.html).toContain("A real page");
  });

  it("tries again after a failed solve, up to the attempts", async () => {
    let tries = 0;
    const got = await solveWall(
      wall,
      async () => page(words),
      async () => {
        tries++;
        return failed;
      },
      3,
      noSleep,
    );
    expect(tries).toBe(3);
    expect(got).toBe(wall);
  });

  it("stops at once when there is no captcha or no eyes for it", async () => {
    for (const out of [none, blind]) {
      let tries = 0;
      await solveWall(
        wall,
        async () => page(words),
        async () => {
          tries++;
          return out;
        },
        3,
        noSleep,
      );
      expect(tries).toBe(1);
    }
  });
});
