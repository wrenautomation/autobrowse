/**
 * Recorded 2026-10-25 on hn.
 * Compiled from the recording "hn-search". Edit freely: the outline was the
 * source until this file was written; from here on this file is.
 */

import { z } from "zod";
import {
  defineFlow,
  defineWorkflow,
  done,
  type FlowRunner,
  records,
  type StepDef,
} from "../../index.js";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  searchQuery: z.string().min(1).describe("Search stories by title, url or author"),
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export interface OpenSearchPageInput {
  searchQuery: string;
}

const openSearchPageFlow = defineFlow<OpenSearchPageInput, void>({
  site: "hn",
  name: "open-search-page",
  async run(fp, input) {
    await fp.open("https://hn.algolia.com/");
    await fp.act(
      { kind: "fill", value: input.searchQuery },
      { role: "searchbox", name: "Search stories by title, url or author" },
      { goal: "fill Search stories by title, url or author" },
    ); // page.getByRole("searchbox", { name: "Search stories by title, url or author", exact: true })
  },
});

const openSearchPage: Step<"open-search-page"> = {
  name: "open-search-page",
  async run({ fx, deps, plan }) {
    await fx.run("browser open-search-page", () =>
      deps.browser.run(openSearchPageFlow, { searchQuery: plan.searchQuery }),
    );
    // TODO: prove the result through an API read where one exists.
    return done("Open the Hacker News Algolia search page");
  },
};

export interface SearchQueryInput {
  searchQuery: string;
}

const searchQueryFlow = defineFlow<SearchQueryInput, Record<string, unknown>>({
  site: "hn",
  name: "search-query",
  async run(fp, input) {
    await fp.open(
      `https://hn.algolia.com/?dateRange=all&page=0&prefix=true&query=${encodeURIComponent(input.searchQuery)}&sort=byPopularity&type=story`,
    );
    const out: Record<string, unknown> = {};
    out.stories = await records(fp, {
      kind: "records",
      goal: "Read the title and points of the first 5 stories",
      as: "stories",
      fields: [
        { key: "title", says: "The title of the story" },
        { key: "points", says: "The points of the story" },
      ],
      key: "title",
      min: 2,
      max: 5,
      sample: [],
      code: `function (root) {
  const stories = root.querySelectorAll('article.Story');
  const result = [];
  stories.forEach(story => {
    const titleElement = story.querySelector('.Story_title a:first-child');
    const pointsElement = story.querySelector('.Story_meta a:first-child');
    const title = titleElement ? titleElement.textContent.trim() : null;
    const points = pointsElement ? pointsElement.textContent.trim().split(' ')[0] : null;
    result.push({ title, points });
  });
  return result.slice(0, 5);
}`,
    });
    return out;
  },
});

const searchQuery: Step<"search-query"> = {
  name: "search-query",
  async run({ fx, deps, plan }) {
    const out = await fx.run("browser search-query", () =>
      deps.browser.run(searchQueryFlow, { searchQuery: plan.searchQuery }),
    );
    // TODO: prove the result through an API read where one exists.
    return done(JSON.stringify(out));
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "hn-search",
  description: "Recorded 2026-10-25 on hn",
  plan: planSchema,
  steps: [openSearchPage, searchQuery],
  emptyMemo: () => ({}),
});
