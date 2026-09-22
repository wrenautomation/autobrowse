import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { digest, hintsFor } from "../src/agent/digest.js";
import { ariaWithFrames } from "../src/browser/frames.js";
import { HUMAN_PACE, handsFor } from "../src/browser/human/index.js";
import { locate } from "../src/browser/locate.js";

describe("iframes in the outline", () => {
  it("shows a nested cross-site checkbox with a ref whose hints reach it, and a paced hand ticks it", async () => {
    // Two hosts, two sites: the inner frame is out of process, like a captcha.
    const srv = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/outer")
        res.end(`<iframe id="captcha-internal" width="340" height="120" src="http://127.0.0.1:${port}/anchor"></iframe>
          <iframe title="hidden" style="visibility:hidden" src="about:blank"></iframe>`);
      else if (req.url === "/anchor")
        res.end(
          `<iframe title="reCAPTCHA" width="300" height="80" src="http://localhost:${port}/box"></iframe>`,
        );
      else
        res.end(
          `<span role="checkbox" aria-checked="false" tabindex="0" aria-label="I'm not a robot"
            onclick="this.setAttribute('aria-checked','true')" style="display:inline-block;width:24px;height:24px;border:1px solid"></span>`,
        );
    }).listen(0);
    const port = (srv.address() as AddressInfo).port;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${port}/outer`);
      await page.frameLocator("iframe#captcha-internal").locator("iframe").waitFor();
      const aria = await ariaWithFrames(page);
      const d = digest(aria);
      expect(d.text).toContain("iframe:");
      const box = d.refs.find((r) => r.role === "checkbox");
      expect(box?.frame).toBe(
        'iframe#captcha-internal >> internal:control=enter-frame >> iframe[title="reCAPTCHA"]',
      );
      const target = locate(page, hintsFor(box as NonNullable<typeof box>));
      await handsFor({ ...HUMAN_PACE, think: [0, 1] }).click(target, { timeout: 5_000 });
      expect(await target.getAttribute("aria-checked")).toBe("true");
    } finally {
      await browser.close();
      srv.close();
    }
  });
});
