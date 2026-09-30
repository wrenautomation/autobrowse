import { describe, expect, it } from "vitest";
import {
  ANSWER_SCRIPT,
  type Asked,
  askUrl,
  PERPLEXITY,
  SOURCES_SCRIPT,
  sourcesOf,
  titleOf,
} from "../src/browser/flows/perplexity-ask.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { PERPLEXITY_API, perplexity, SITES } from "../src/sites/index.js";
import { completionOf, questionOf } from "../src/sites/perplexity.js";

const route = () => {
  const r = perplexity.routes.find((x) => x.method === "POST" && x.path === "/chat/completions");
  if (!r) throw new Error("no POST /chat/completions");
  return r;
};

describe("perplexity card titles", () => {
  it("strips a › breadcrumb of the host and every path segment", () => {
    expect(
      titleOf(
        "churnkey.co › guides › reactivation-campaignsWhat is a reactivation campaign?",
        "https://churnkey.co/guides/reactivation-campaigns",
      ),
    ).toBe("What is a reactivation campaign?");
  });

  it("strips a · breadcrumb the same way", () => {
    expect(titleOf("x.test · blog · postThe Post", "https://x.test/blog/post")).toBe("The Post");
  });

  it("matches the host with or without www.", () => {
    expect(titleOf("x.test › aTitle", "https://www.x.test/a")).toBe("Title");
    expect(titleOf("www.x.test › aTitle", "https://www.x.test/a")).toBe("Title");
  });

  it("decodes path segments before matching", () => {
    expect(
      titleOf("x.test › wiki › café noirCafé noir", "https://x.test/wiki/caf%C3%A9%20noir"),
    ).toBe("Café noir");
  });

  it("stops at the first segment the breadcrumb does not spell", () => {
    expect(titleOf("x.test › aTitle", "https://x.test/a/b/c")).toBe("Title");
  });

  it("returns raw when there is no host prefix, or stripping leaves nothing", () => {
    expect(titleOf("A plain title", "https://x.test/a")).toBe("A plain title");
    expect(titleOf("x.test › a", "https://x.test/a")).toBe("x.test › a");
    expect(titleOf("x.test", "https://x.test/")).toBe("x.test");
    expect(titleOf("anything", "not a url")).toBe("anything");
  });

  it("a path with a stray % does not throw", () => {
    expect(() => titleOf("x.test › 100%Title", "https://x.test/100%")).not.toThrow();
  });
});

describe("perplexity source cards", () => {
  it("reads [href, site, url, title, snippet], url line optional", () => {
    expect(
      sourcesOf([
        [
          "https://churnkey.co/guides/r",
          "churnkey",
          "https://churnkey.co/guides/r",
          "churnkey.co › guides › rWhat it is",
          "A snippet.",
        ],
        ["https://b.test/", "b", "B title", "B snippet"],
      ]),
    ).toEqual([
      {
        site: "churnkey",
        url: "https://churnkey.co/guides/r",
        title: "What it is",
        snippet: "A snippet.",
      },
      { site: "b", url: "https://b.test/", title: "B title", snippet: "B snippet" },
    ]);
  });

  it("dedupes by href; a short card has null title and snippet", () => {
    expect(
      sourcesOf([
        ["https://a.test/", "a", "A"],
        ["https://a.test/", "a again", "A2", "s"],
        ["https://c.test/"],
        [],
      ]),
    ).toEqual([
      { site: "a", url: "https://a.test/", title: "A", snippet: null },
      { site: "", url: "https://c.test/", title: null, snippet: null },
    ]);
  });
});

describe("perplexity ask flow", () => {
  it("asks by URL", () => {
    expect(askUrl("what is a b&c?")).toBe(`${PERPLEXITY}/search?q=what+is+a+b%26c%3F`);
  });

  it("page scripts parse as expressions", () => {
    expect(() => new Function(`return ${ANSWER_SCRIPT}`)).not.toThrow();
    expect(() => new Function(`return ${SOURCES_SCRIPT}`)).not.toThrow();
  });

  it("is served as perplexity/ask", () => {
    expect(BROWSER_FLOWS["perplexity/ask"]?.name).toBe("ask");
  });
});

describe("perplexity site", () => {
  it("is served, via google, one POST route with both legs", () => {
    expect(SITES).toContain(perplexity);
    expect(perplexity.origin).toBe(PERPLEXITY_API);
    expect(perplexity.via).toBe("google");
    expect(perplexity.routes).toHaveLength(1);
    expect(route().api).toBeTypeOf("function");
    expect(route().browser).toMatchObject({ flow: "perplexity/ask" });
    expect(route().meter?.({} as never)).toEqual({ ask: 1 });
  });

  it("asks the last user message, trimmed", () => {
    const c = {
      model: "sonar",
      messages: [
        { role: "system" as const, content: "be brief" },
        { role: "user" as const, content: "first" },
        { role: "assistant" as const, content: "ok" },
        { role: "user" as const, content: "  second?  " },
        { role: "assistant" as const, content: "trailing" },
      ],
    };
    expect(questionOf(c)).toBe("second?");
    expect(route().browser?.input?.(c as never, () => undefined)).toEqual({ q: "second?" });
  });

  it("request: model defaults to sonar; needs a non-empty user message", () => {
    const ok = route().request.safeParse({ messages: [{ role: "user", content: "hi" }] });
    expect(ok.success).toBe(true);
    expect(ok.data).toMatchObject({ model: "sonar" });
    const bad = [
      {},
      { messages: [] },
      { messages: [{ role: "system", content: "x" }] },
      { messages: [{ role: "user", content: "   " }] },
      { messages: [{ role: "robot", content: "hi" }] },
    ];
    for (const b of bad) expect(route().request.safeParse(b).success).toBe(false);
    const extra = route().request.safeParse({
      model: "sonar-pro",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
    });
    expect(extra.data).toMatchObject({ model: "sonar-pro", temperature: 0.2 });
  });

  it("answers the web page in the API's shape", () => {
    const asked: Asked = {
      query: "q",
      text: "The answer [1].",
      thread: "https://www.perplexity.ai/search/abc-123_XY",
      sources: [
        { site: "a", url: "https://a.test/", title: "A title", snippet: "s1" },
        { site: "b", url: "https://b.test/", title: null, snippet: null },
      ],
    };
    const out = completionOf(asked);
    expect(out).toMatchObject({
      id: "abc-123_XY",
      model: "perplexity-web",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "The answer [1]." },
        },
      ],
      citations: ["https://a.test/", "https://b.test/"],
      search_results: [
        { title: "A title", url: "https://a.test/", snippet: "s1" },
        { title: "b", url: "https://b.test/", snippet: null },
      ],
      thread: asked.thread,
    });
    expect(Number.isInteger(out.created)).toBe(true);
    expect(route().browser?.output?.(asked)).toMatchObject({ id: "abc-123_XY" });
  });
});
