import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { digest, hintsFor } from "../src/agent/digest.js";
import { ariaWithFrames, withFrame } from "../src/browser/frames.js";
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

  it("a target the page lacks is found in a card provider's iframe, and left alone otherwise", async () => {
    const srv = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/pay")
        res.end(`<label>Name <input></label>
          <iframe id="braintree-hosted-field-number" width="300" height="60" src="http://localhost:${port}/field"></iframe>`);
      else res.end(`<input aria-label="Credit Card Number">`);
    }).listen(0);
    const port = (srv.address() as AddressInfo).port;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/pay`);
      await page.frameLocator("iframe").locator("input").waitFor();
      const card = await withFrame(page, { role: "textbox", name: "Credit Card Number" });
      expect(card.frame).toBe("iframe#braintree-hosted-field-number");
      await locate(page, card).fill("4242");
      expect(await locate(page, card).inputValue()).toBe("4242");
      // On the page itself: no frame added. Nowhere: unchanged, so the miss says what was asked.
      expect(await withFrame(page, { role: "textbox", name: "Name" })).toEqual({
        role: "textbox",
        name: "Name",
      });
      expect(await withFrame(page, { role: "button", name: "Pay" })).toEqual({
        role: "button",
        name: "Pay",
      });
    } finally {
      await browser.close();
      srv.close();
    }
  });
  it("a 3-D Secure code box four cross-origin frames down is found, and found while the frames still load", async () => {
    let port = 0;
    const srv = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      const frame = (host: string, path: string, title: string) =>
        `<iframe title="${title}" width="360" height="200" src="http://${host}:${port}${path}"></iframe>`;
      // Each frame sits on the other host: two sites, so out of process like a bank's ACS.
      if (req.url === "/pay") res.end(`<h1>Checkout</h1>${frame("127.0.0.1", "/a", "3ds")}`);
      else if (req.url === "/a") res.end(frame("localhost", "/b", "acs"));
      else if (req.url === "/b") res.end(frame("127.0.0.1", "/c", "bank"));
      else if (req.url === "/c") res.end(frame("localhost", "/d", "challenge"));
      else res.end(`<label>Confirmation code <input></label>`);
    }).listen(0);
    port = (srv.address() as AddressInfo).port;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${port}/pay`);
      // No wait for the frames: the search gives them the time it is told to.
      const box = await withFrame(page, { role: "textbox", name: "Confirmation code" }, 5_000);
      expect(box.frame?.split(">> internal:control=enter-frame >>")).toHaveLength(4);
      await locate(page, box).fill("123456");
      expect(await locate(page, box).inputValue()).toBe("123456");
      // No wait asked, nothing found yet: the hints come back as they were.
      const none = await withFrame(page, { role: "button", name: "Pay" });
      expect(none).toEqual({ role: "button", name: "Pay" });
    } finally {
      await browser.close();
      srv.close();
    }
  });
});
