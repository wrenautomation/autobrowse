import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/app/config.js";
import { headed, screenOf } from "../src/app/screen.js";
import { browserOptions } from "../src/app/services.js";

const settings = loadSettings({
  RESTATE_INGRESS_URL: "http://127.0.0.1:8080",
  BROWSER: "local",
  BROWSER_HEADLESS: "true",
});

describe("screen", () => {
  it("browser options read the screen when a browser opens, not when they were built", () => {
    const screen = screenOf(settings);
    const opts = browserOptions(settings, screen);
    expect(opts.headless).toBe(true);
    screen.headless = false;
    expect(opts.headless).toBe(false);
  });

  it("a person's --headed is fixed and never flips", () => {
    expect(browserOptions(settings, headed).headless).toBe(false);
    expect(() => {
      (headed as { headless: boolean }).headless = true;
    }).toThrow();
  });
});
