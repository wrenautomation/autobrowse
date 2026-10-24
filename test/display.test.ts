import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/app/config.js";
import { displayOf, headed } from "../src/app/display.js";
import { browserOptions } from "../src/app/services.js";

const settings = loadSettings({
  RESTATE_INGRESS_URL: "http://127.0.0.1:8080",
  BROWSER: "local",
  BROWSER_HEADLESS: "true",
});

describe("display", () => {
  it("browser options read the display when a browser opens, not when they were built", () => {
    const display = displayOf(settings);
    const opts = browserOptions(settings, display);
    expect(opts.headless).toBe(true);
    display.headless = false;
    expect(opts.headless).toBe(false);
  });

  it("a person's --headed is fixed and never flips", () => {
    expect(browserOptions(settings, headed).headless).toBe(false);
    expect(() => {
      (headed as { headless: boolean }).headless = true;
    }).toThrow();
  });
});
