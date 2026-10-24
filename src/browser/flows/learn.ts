/**
 * LEARN (learn.uwaterloo.ca, D2L Brightspace), signed in as `outlook@uw`
 * (`auth/uwaterloo.ts`). Mapped 2026-10-23 in explore on PD 10 (ou 1285415).
 *
 * Reads call D2L's own REST API (Valence) from inside the signed-in page:
 * same origin, the session's cookies, no app key. It answers
 * `/d2l/api/lp/1.43/enrollments/myenrollments/`, `/d2l/api/le/1.67/{ou}/
 * dropbox/folders/`, `.../quizzes/` and `.../content/toc`. It refuses a
 * student's own dropbox submissions (403 "No scopes defined") and quiz
 * attempts (needs Quizzing.GradeAttempts), so those come from the list pages:
 * `folders_list.d2l` ("Not Submitted" or "1 Submission, 1 File") and
 * `quizzes_list.d2l` ("used / allowed"). Content pages are iframes under
 * `/content/enforced/<ou>-<code>/`; their files download the same way, with
 * an in-page fetch, as base64.
 *
 * Courses, dropbox folders and the dropbox submit are walks now, cut from an
 * explore run (`walks cut learn`, designs/2026-10-23-cut-runs.md):
 * learn/walk-courses, walk-dropbox-folders, walk-dropbox-submit.
 *
 * Writes use the pages, as a person does.
 * - Quiz: `quiz_summary.d2l?qi=&ou=` → "Start Quiz!" (or "Continue Quiz..."
 *   for an attempt left open). The questions sit two frames deep
 *   (`QUIZ_FRAME`), one fieldset per question after its "Question N" heading.
 *   D2L saves each answer as it is picked. "Submit Quiz" there opens a
 *   confirmation in the same frame; its "Submit Quiz" ends the attempt, blank
 *   questions or not. The result ("Your work has been saved and submitted",
 *   the score) and "Done" are in frame `iframe#ctl_2`. The attempt list is
 *   `quiz_submissions.d2l?qi=&ou=`. Run end to end on the practice quiz
 *   (qi 325150, unlimited), 2026-10-23.
 */
import { LEARN } from "../../auth/uwaterloo.js";
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";

/** The little of the DOM these page scripts touch; the project compiles without lib dom. */
interface El {
  id: string;
  tagName: string;
  type?: string;
  checked?: boolean;
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
  closest(sel: string): El | null;
  click(): void;
}
declare const document: El & {
  createElement(tag: "template"): { innerHTML: string; content: El };
};

const LE = "/d2l/api/le/1.67";
/** The quiz's question page: a frame inside the attempt's frame. */
export const QUIZ_FRAME = "iframe#ctl_2 >> internal:control=enter-frame >> iframe#FRM_page";
const ATTEMPT_FRAME = "iframe#ctl_2";
const PAGE_MS = 15_000;

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** One Valence GET from the signed-in page; a refusal goes to a person. */
async function valence<T>(fp: FlowPage, path: string): Promise<T> {
  if (!fp.url().startsWith(`${LEARN}/d2l/`)) await fp.open(`${LEARN}/d2l/home`);
  const res = await fp.page.evaluate(async (p) => {
    const r = await fetch(p, { credentials: "include" });
    return { status: r.status, body: r.ok ? await r.text() : (await r.text()).slice(0, 200) };
  }, path);
  if (res.status !== 200)
    return fp.human(`LEARN's API answered ${res.status} for ${path}: ${res.body}`);
  return JSON.parse(res.body) as T;
}

/** One row of a course's list page: its name and what each column says. */
async function listRows(fp: FlowPage, url: string): Promise<{ name: string; cells: string[] }[]> {
  await fp.open(url);
  await fp.has({ css: "table tr" }, PAGE_MS);
  return fp.page
    .evaluate(() =>
      [...document.querySelectorAll("table tr")].flatMap((tr) => {
        const cells = [...tr.querySelectorAll(":scope > td, :scope > th")];
        const first = cells[0];
        const title = first?.querySelector("strong, a, label");
        // Section and column headers have no second cell or are `th scope=col`.
        if (!first || cells.length < 2 || !title || first.getAttribute("scope") === "col")
          return [];
        return [
          { name: title.textContent ?? "", cells: cells.slice(1).map((c) => c.textContent ?? "") },
        ];
      }),
    )
    .then((rows) => rows.map((r) => ({ name: squash(r.name), cells: r.cells.map(squash) })));
}

export interface Quiz {
  qi: number;
  name: string;
  /** Attempts made; null when the list page does not show the quiz. */
  used: number | null;
  /** Attempts allowed; null for unlimited or unknown. */
  allowed: number | null;
}

/** A course's quizzes and the attempts left on each. */
export const learnQuizzes = defineFlow<{ ou: number }, Quiz[]>({
  site: "learn",
  name: "quizzes",
  async run(fp, { ou }) {
    const quizzes = await valence<{ Objects: { QuizId: number; Name: string }[] }>(
      fp,
      `${LE}/${ou}/quizzes/`,
    );
    const rows = await listRows(fp, `${LEARN}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${ou}`);
    return quizzes.Objects.map((q) => {
      const row = rows.find((r) => r.name === squash(q.Name));
      const m = row?.cells.at(-1)?.match(/(\d+)\s*\/\s*(\d+|unlimited)/i);
      return {
        qi: q.QuizId,
        name: q.Name,
        used: m ? Number(m[1]) : null,
        allowed: m && /^\d+$/.test(m[2] as string) ? Number(m[2]) : null,
      };
    });
  },
});

export interface Attempt {
  ai: number;
  /** "3 / 3 - 100 %", or null before it is graded. */
  score: string | null;
  /** The review page: each question, the options marked selected and correct, the feedback. */
  text: string;
}

/** A quiz's attempts as their review pages show them. */
export const learnQuizReview = defineFlow<{ ou: number; qi: number }, Attempt[]>({
  site: "learn",
  name: "quiz-review",
  async run(fp, { ou, qi }) {
    await fp.open(`${LEARN}/d2l/lms/quizzing/user/quiz_submissions.d2l?qi=${qi}&ou=${ou}`);
    await fp.has({ css: "a[href*=quiz_submissions_attempt]" }, PAGE_MS);
    const links = await fp.page.evaluate(() =>
      [...document.querySelectorAll("a[href*=quiz_submissions_attempt]")].map(
        (a) => a.getAttribute("href") ?? "",
      ),
    );
    const out: Attempt[] = [];
    for (const href of links) {
      const ai = Number(href.match(/[?&]ai=(\d+)/)?.[1]);
      await fp.open(new URL(href, LEARN).href);
      const text = await fp.text();
      out.push({
        ai,
        score: text.match(/Attempt Score\s*\|?\s*([^\n]+)/)?.[1]?.trim() ?? null,
        text,
      });
    }
    return out;
  },
});

export interface Answer {
  /** The question's number on the page: "Question 3" is 3. */
  question: number;
  /** The options to pick, by their exact text: one for a radio question, any for checkboxes. */
  choices: string[];
}

export interface AttemptInput {
  ou: number;
  qi: number;
  answers: Answer[];
  /** Submit the attempt; false picks and saves the answers and leaves it open. */
  submit: boolean;
}

/**
 * In the question frame: the inputs for one question's options, each with its
 * text and state. A question is the first fieldset after its heading. An
 * option's text is a `d2l-html-block`, drawn in a shadow root from its `html`
 * attribute, so the light DOM has no text.
 */
function optionsOf(body: El, question: number) {
  const all = [...body.querySelectorAll("h2, fieldset")];
  const at = all.findIndex(
    (e) =>
      e.tagName === "H2" && new RegExp(`^\\s*Question ${question}\\b`).test(e.textContent ?? ""),
  );
  const set = at < 0 ? undefined : all.slice(at + 1).find((e) => e.tagName === "FIELDSET");
  if (!set) return null;
  return [...set.querySelectorAll("input[type=radio], input[type=checkbox]")].map((i) => {
    const block = i.closest("tr")?.querySelector("d2l-html-block");
    const html = document.createElement("template");
    html.innerHTML = block?.getAttribute("html") ?? "";
    return {
      id: i.id,
      type: i.type ?? "",
      checked: !!i.checked,
      text: html.content.textContent ?? "",
    };
  });
}

/** Answer a quiz by option text, check each answer took, and with `submit` end the attempt. */
export const learnQuizAttempt = defineFlow<
  AttemptInput,
  { submitted: boolean; attempt: Attempt | null }
>({
  site: "learn",
  name: "quiz-attempt",
  async run(fp, input) {
    await fp.open(`${LEARN}/d2l/lms/quizzing/user/quiz_summary.d2l?ou=${input.ou}&qi=${input.qi}`);
    const start: Hints = { role: "button", name: "/^(start quiz!|continue quiz)/i" };
    if (!(await fp.has(start, PAGE_MS)))
      return fp.human(`no Start Quiz on ${fp.url()}: no attempts left?`);
    await fp.act({ kind: "click" }, start, { goal: "open the attempt" });
    const body = fp.page.frameLocator(QUIZ_FRAME).locator("body");
    await fp.page
      .frameLocator(QUIZ_FRAME)
      .locator("fieldset")
      .first()
      .waitFor({ timeout: PAGE_MS });
    const read = (q: number) =>
      body.evaluate(optionsOf as (b: unknown, q: number) => ReturnType<typeof optionsOf>, q);
    for (const a of input.answers) {
      const options = await read(a.question);
      if (!options?.length)
        return fp.human(`no options for question ${a.question} (more than one page?)`);
      const want = new Set(a.choices.map(squash));
      const missing = [...want].filter((c) => !options.some((o) => squash(o.text) === c));
      if (missing.length)
        return fp.human(
          `question ${a.question} has no option ${JSON.stringify(missing)}; it offers ${JSON.stringify(options.map((o) => squash(o.text)))}`,
        );
      for (const o of options) {
        const on = want.has(squash(o.text));
        // A checkbox toggles: click only what differs. A radio is only ever turned on.
        if (on === o.checked || (!on && o.type === "radio")) continue;
        await fp.act(
          { kind: "click" },
          { css: `[id="${o.id}"]`, frame: QUIZ_FRAME },
          { goal: `${on ? "pick" : "clear"} "${squash(o.text)}" on question ${a.question}` },
        );
      }
      const after = (await read(a.question)) ?? [];
      const wrong = after.filter((o) => o.checked !== want.has(squash(o.text)));
      if (wrong.length) return fp.human(`question ${a.question} did not take its answer`);
    }
    if (!input.submit) return { submitted: false, attempt: null };
    // LEARN submits blank questions without a stop, so this flow stops first.
    const blank = await body.evaluate(
      (b) =>
        [...(b as unknown as El).querySelectorAll("fieldset")].filter(
          (f) =>
            f.querySelector("input[type=radio], input[type=checkbox]") &&
            !f.querySelector("input:checked"),
        ).length,
    );
    if (blank) return fp.human(`${blank} question(s) have no answer; not submitted`);
    const submit: Hints = { role: "button", name: "Submit Quiz", frame: QUIZ_FRAME };
    await fp.act({ kind: "click" }, submit, { goal: "go to the submit confirmation" });
    const confirm: Hints = { text: "/once you press the submit quiz button/i", frame: QUIZ_FRAME };
    if (!(await fp.has(confirm, PAGE_MS))) return fp.human("no submit confirmation");
    await fp.act({ kind: "click" }, submit, { goal: "submit the attempt", irreversible: true });
    const said: Hints = { role: "heading", name: "/saved and submitted/i", frame: ATTEMPT_FRAME };
    if (!(await fp.has(said, PAGE_MS)))
      return fp.human("LEARN did not say the attempt was submitted");
    const done: Hints = { role: "button", name: "Done", frame: ATTEMPT_FRAME };
    if (await fp.has(done, 5_000))
      await fp.act({ kind: "click" }, done, { goal: "close the attempt" });
    const attempts = await learnQuizReview.run(fp, { ou: input.ou, qi: input.qi });
    return { submitted: true, attempt: attempts.at(-1) ?? null };
  },
});
