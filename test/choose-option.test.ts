import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { chooseOption } from "../src/browser/flow.js";
import { instantHands } from "../src/browser/human/index.js";

describe("chooseOption", () => {
  it("picks on a native select, and on a custom dropdown by opening it and clicking the option", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <select id="native"><option>January</option><option>June</option></select>
      <div>
        <button id="open" aria-haspopup="listbox" onclick="document.getElementById('list').hidden=false">Month</button>
        <ul id="list" role="listbox" hidden>
          <li role="option" onclick="document.getElementById('picked').textContent='January'">January</li>
          <li role="option" onclick="document.getElementById('picked').textContent='June'">June</li>
        </ul>
        <span id="picked"></span>
      </div>`);
    await chooseOption(page, page.locator("#native"), "June", 2_000);
    expect(await page.locator("#native").inputValue()).toBe("June");
    await chooseOption(page, page.locator("#open"), "June", 2_000);
    expect(await page.locator("#picked").textContent()).toBe("June");
    await expect(chooseOption(page, page.locator("#open"), "Smarch", 500)).rejects.toThrow();
    await browser.close();
  });

  it("paste picks from a dropdown of plain divs, the way place fills a card expiry", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <div id="month"><div id="trigger" onclick="document.getElementById('list').hidden=false">01</div></div>
      <div id="list" hidden>
        <div onclick="document.getElementById('trigger').textContent='01'">01</div>
        <div onclick="document.getElementById('trigger').textContent='07'">07</div>
      </div>
      <input id="name">`);
    await instantHands.paste(page.locator("#trigger"), "07", { timeout: 2_000 });
    expect(await page.locator("#trigger").textContent()).toBe("07");
    await instantHands.paste(page.locator("#name"), "Ann", { timeout: 2_000 });
    expect(await page.locator("#name").inputValue()).toBe("Ann");
    await browser.close();
  });
});
