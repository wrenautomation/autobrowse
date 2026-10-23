import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FlowPage } from "../src/browser/flow.js";
import { type Hints, locate } from "../src/browser/locate.js";
import { walkFlow } from "../src/walks/flow.js";
import { walkSpecSchema } from "../src/walks/spec.js";

/** Two questions; option text lives in a shadow root (as LEARN's `d2l-html-block`), names are numbers. */
const QUIZ = `<script>customElements.define('x-html', class extends HTMLElement { connectedCallback() {
  this.attachShadow({ mode: 'open' }).innerHTML = this.getAttribute('html'); } });</script>
<h2>Question 1</h2><fieldset><table>
  <tr><td>a.</td><td><input type="radio" name="q1" aria-label="1"></td><td><x-html html="<p>Red</p>"></x-html></td></tr>
  <tr><td>b.</td><td><input type="radio" name="q1" aria-label="2"></td><td><x-html html="<p>Blue</p>"></x-html></td></tr>
</table></fieldset>
<h2>Question 2</h2><fieldset><table>
  <tr><td>a.</td><td><input type="checkbox" aria-label="1" checked></td><td><x-html html="<p>Cats  bark</p>"></x-html></td></tr>
  <tr><td>b.</td><td><input type="checkbox" aria-label="2"></td><td><x-html html="<p>Dogs bark</p>"></x-html></td></tr>
  <tr><td>c.</td><td><input type="checkbox" aria-label="3"></td><td><x-html html="<p>Birds sing</p>"></x-html></td></tr>
</table></fieldset>`;

class Human extends Error {}

function flowPage(page: Page, clicks: string[]): FlowPage {
  return {
    page,
    url: () => page.url(),
    wait: async () => {},
    has: (h: Hints, ms = 0) =>
      locate(page, h)
        .first()
        .waitFor({ timeout: ms || 1 })
        .then(
          () => true,
          () => false,
        ),
    async act(_op, h: Hints, o) {
      clicks.push(o.goal);
      await locate(page, h).click();
    },
    human(reason: string): never {
      throw new Human(reason);
    },
  } as unknown as FlowPage;
}

const answer = walkSpecSchema.parse({
  version: 2,
  site: "lms",
  name: "answer",
  goal: "answer one question",
  built: "2026-10-23T12:00:00.000Z",
  from: [],
  start: null,
  fields: [
    { key: "question", label: "question", example: "1" },
    { key: "choices", label: "choices", example: "" },
  ],
  secrets: [],
  irreversible: false,
  screens: [
    {
      name: "question",
      looks: "any",
      url: null,
      landmarks: [],
      once: true,
      seen: 1,
      ops: [
        {
          kind: "pick",
          goal: "answer question {question}",
          region: {
            css: "xpath=//h2[starts-with(normalize-space(), 'Question {question}')]/following::fieldset[1]",
          },
          row: "tr",
          label: "x-html",
          choices: "{choices}",
        },
      ],
    },
    {
      name: "done",
      looks: "question",
      url: null,
      landmarks: [],
      ops: [],
      goal: true,
      after: ["question"],
      seen: 1,
    },
  ],
});

/** One screen of ops over the fields `question`, `choices` and `file`. */
const walkOf = (ops: unknown[]) =>
  walkSpecSchema.parse({
    ...answer,
    fields: [...answer.fields, { key: "file", label: "file", example: null }],
    screens: [{ ...answer.screens[0], ops }, answer.screens[1]],
  });

describe("pick", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });
  const run = async (question: string, choices: string, clicks: string[] = []) => {
    await walkFlow(answer).run(flowPage(page, clicks), { question, choices });
    return clicks;
  };
  const checked = () =>
    page.locator("input").evaluateAll((els) => els.map((e) => (e as { checked: boolean }).checked));

  it("chooses by the text in a shadow root, in one question, clicking only what differs", async () => {
    page = await browser.newPage();
    await page.setContent(QUIZ);
    expect(await run("2", '["dogs bark", "Birds  sing"]')).toEqual([
      'clear "cats bark"',
      'pick "dogs bark"',
      'pick "birds sing"',
    ]);
    expect(await run("1", "Blue")).toEqual(['pick "blue"']);
    expect(await checked()).toEqual([false, true, false, true, true]);
    // Already as wanted: no click.
    expect(await run("2", '["Dogs bark","Birds sing"]')).toEqual([]);
  });

  it("stops with the options it found when a choice is not there, before any click", async () => {
    page = await browser.newPage();
    await page.setContent(QUIZ);
    const clicks: string[] = [];
    await expect(run("1", "Green", clicks)).rejects.toThrow(
      'answer question 1: no option ["green"]; it offers ["red","blue"]',
    );
    expect(clicks).toEqual([]);
  });

  it("stops when a click did not take", async () => {
    page = await browser.newPage();
    await page.setContent(QUIZ);
    // The page undoes every change: the read back sees it.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("input"))
        el.addEventListener("click", (e) => e.preventDefault());
    });
    await expect(run("1", "Red")).rejects.toThrow('answer question 1: ["red"] did not take');
  });

  it("sees a file by its name, or a field's text; else stops", async () => {
    page = await browser.newPage();
    await page.setContent("<p>Files: report (1).pdf</p><p>Saved for Ann</p>");
    const file = { kind: "see", goal: "the file attached", file: "{file}", ms: 200 };
    const saved = { kind: "see", goal: "saved", hints: { text: "Saved for {choices}" }, ms: 200 };
    const fp = flowPage(page, []);
    await walkFlow(walkOf([file, saved])).run(fp, {
      question: "1",
      choices: "Ann",
      file: "/tmp/x/report (1).pdf",
    });
    await expect(
      walkFlow(walkOf([file])).run(fp, { question: "1", choices: "", file: "/tmp/other.pdf" }),
    ).rejects.toThrow("the file attached: not on");
  });
});
