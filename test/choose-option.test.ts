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
    await chooseOption(page.locator("#native"), "June", 2_000);
    expect(await page.locator("#native").inputValue()).toBe("June");
    await chooseOption(page.locator("#open"), "June", 2_000);
    expect(await page.locator("#picked").textContent()).toBe("June");
    await expect(chooseOption(page.locator("#open"), "Smarch", 500)).rejects.toThrow();
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

  it("opens a 0x0 combobox by its box and scrolls a long list to the option (Discord's years)", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <div id="host" style="width:120px;height:40px;border:1px solid" onclick="open_()">
        <div role="combobox" aria-label="Year" style="width:0;height:0;overflow:hidden"></div>
        <span id="picked">Year</span>
      </div>
      <div id="list" role="listbox" hidden style="height:160px;overflow:auto;position:relative">
        <div id="rows" style="height:${40 * 32}px"></div>
      </div>
      <script>
        // Only the rows in view exist, as a virtualized list renders them.
        const years = Array.from({ length: 40 }, (_, i) => String(2026 - i));
        const list = document.getElementById("list"), rows = document.getElementById("rows");
        function paint() {
          const first = Math.floor(list.scrollTop / 32);
          rows.innerHTML = years
            .slice(first, first + 6)
            .map((y, i) => \`<div role="option" style="position:absolute;top:\${(first + i) * 32}px;height:32px">\${y}</div>\`)
            .join("");
        }
        list.addEventListener("click", (e) => {
          if (e.target.getAttribute("role") === "option") document.getElementById("picked").textContent = e.target.textContent;
        });
        list.addEventListener("scroll", paint);
        function open_() { list.hidden = false; paint(); }
      </script>`);
    await chooseOption(page.getByRole("combobox", { name: "Year" }), "2007", 2_000);
    expect(await page.locator("#picked").textContent()).toBe("2007");
    await browser.close();
  });
});
