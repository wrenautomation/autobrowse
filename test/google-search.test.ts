import { describe, expect, it } from "vitest";
import {
  GOOGLE,
  type RawSerp,
  redirectTarget,
  SERP_SCRIPT,
  searchUrl,
  serpOf,
  targetOf,
} from "../src/browser/flows/google-search.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";

/** A resolver that answers from a table and records what it was asked. */
function resolverOf(table: Record<string, string | null>) {
  const asked: string[] = [];
  const resolve = async (abs: string) => {
    asked.push(abs);
    if (abs.includes("boom")) throw new Error("network");
    return table[abs] ?? null;
  };
  return { resolve, asked };
}

const result = (href: string, title = href): RawSerp["results"][number] => ({
  title,
  href,
  site: null,
  shown: null,
  snippet: null,
  date: null,
});

const page = (p: Partial<RawSerp>): RawSerp => ({
  overview: null,
  results: [],
  ads: [],
  questions: [],
  ...p,
});

describe("google search url", () => {
  it("asks in English by default, page 0 has no start", () => {
    const u = new URL(searchUrl({ q: "cold email tools" }));
    expect(u.origin + u.pathname).toBe(`${GOOGLE}/search`);
    expect(u.searchParams.get("q")).toBe("cold email tools");
    expect(u.searchParams.get("hl")).toBe("en");
    expect(u.searchParams.has("gl")).toBe(false);
    expect(u.searchParams.has("start")).toBe(false);
  });

  it("carries hl, gl and the page offset", () => {
    const u = new URL(searchUrl({ q: "a&b", hl: "fr", gl: "ca" }, 2));
    expect(u.searchParams.get("q")).toBe("a&b");
    expect(u.searchParams.get("hl")).toBe("fr");
    expect(u.searchParams.get("gl")).toBe("ca");
    expect(u.searchParams.get("start")).toBe("20");
  });
});

describe("google result targets", () => {
  it("a plain link is itself, never resolved", async () => {
    const { resolve, asked } = resolverOf({});
    expect(await targetOf("https://mailshake.com/blog", resolve)).toBe(
      "https://mailshake.com/blog",
    );
    expect(asked).toEqual([]);
  });

  it("/url?q= carries its target (and ?url= when there is no q)", async () => {
    const { resolve, asked } = resolverOf({});
    expect(await targetOf("/url?q=https://a.test/x%3Fy%3D1&sa=U", resolve)).toBe(
      "https://a.test/x?y=1",
    );
    expect(await targetOf("https://www.google.com/url?url=https://b.test/", resolve)).toBe(
      "https://b.test/",
    );
    expect(await targetOf("/url?sa=U", resolve)).toBeNull();
    expect(asked).toEqual([]);
  });

  it("/goto and /aclk go to the resolver as absolute google URLs", async () => {
    const { resolve, asked } = resolverOf({
      "https://www.google.com/goto?url=TOKEN": "https://target.test/",
      "https://www.google.com/aclk?sa=l&ai=AD": "https://ad.test/",
    });
    expect(await targetOf("/goto?url=TOKEN", resolve)).toBe("https://target.test/");
    expect(await targetOf("/aclk?sa=l&ai=AD", resolve)).toBe("https://ad.test/");
    expect(asked).toEqual([
      "https://www.google.com/goto?url=TOKEN",
      "https://www.google.com/aclk?sa=l&ai=AD",
    ]);
  });

  it("a non-google host passes through even on a /url or /goto path", async () => {
    const { resolve, asked } = resolverOf({});
    expect(await targetOf("https://example.com/url?q=https://x.test/", resolve)).toBe(
      "https://example.com/url?q=https://x.test/",
    );
    expect(await targetOf("https://notgoogle.com/goto?url=T", resolve)).toBe(
      "https://notgoogle.com/goto?url=T",
    );
    expect(asked).toEqual([]);
  });

  it("an empty href is null; another google page is itself", async () => {
    const { resolve } = resolverOf({});
    expect(await targetOf("", resolve)).toBeNull();
    expect(await targetOf("https://www.google.co.uk/maps/place/x", resolve)).toBe(
      "https://www.google.co.uk/maps/place/x",
    );
  });
});

describe("google redirect target", () => {
  it("prefers the Location header", () => {
    expect(
      redirectTarget(
        "https://a.test/?x=1",
        '<meta http-equiv="refresh" content="0;url=https://b.test/">',
      ),
    ).toBe("https://a.test/?x=1");
  });

  it("reads a meta refresh, &amp; unescaped", () => {
    expect(
      redirectTarget(
        undefined,
        '<meta http-equiv="refresh" content="0;url=https://a.test/?x=1&amp;y=2">',
      ),
    ).toBe("https://a.test/?x=1&y=2");
    expect(
      redirectTarget(undefined, "<META HTTP-EQUIV=refresh CONTENT=0;URL=https://a.test/p>"),
    ).toBe("https://a.test/p");
  });

  it("reads a meta refresh whose content comes before http-equiv", () => {
    expect(
      redirectTarget(undefined, '<meta content="0;url=https://a.test/p" http-equiv="refresh">'),
    ).toBe("https://a.test/p");
  });

  it("reads location.replace, \\x3d and \\x26 unescaped", () => {
    const body = String.raw`<script>location.replace("https://a.test/?q\x3dhi\x26n\x3d2")</script>`;
    expect(redirectTarget(undefined, body)).toBe("https://a.test/?q=hi&n=2");
    expect(
      redirectTarget(undefined, "<script>window.location.replace('https://c.test/')</script>"),
    ).toBe("https://c.test/");
  });

  it("anything not http(s) is null, as is nothing at all", () => {
    expect(redirectTarget("/sorry/index?continue=x", "")).toBeNull();
    expect(redirectTarget("javascript:alert(1)", "")).toBeNull();
    expect(
      redirectTarget(undefined, '<script>location.replace("/search?q=x")</script>'),
    ).toBeNull();
    expect(redirectTarget(undefined, "<html>nothing here</html>")).toBeNull();
    expect(redirectTarget(undefined, "")).toBeNull();
  });
});

describe("google serp from raw pages", () => {
  it("dedupes results by href across pages, cuts to n, numbers from 1", async () => {
    const { resolve } = resolverOf({});
    const serp = await serpOf(
      "q",
      [
        page({ results: [result("https://a.test/"), result("https://b.test/")] }),
        page({
          results: [
            result("https://b.test/", "b again"),
            result("https://c.test/"),
            result("https://d.test/"),
          ],
        }),
      ],
      3,
      resolve,
    );
    expect(serp.results.map((r) => [r.position, r.url, r.title])).toEqual([
      [1, "https://a.test/", "https://a.test/"],
      [2, "https://b.test/", "https://b.test/"],
      [3, "https://c.test/", "https://c.test/"],
    ]);
    expect(serp.results[0]).not.toHaveProperty("href");
  });

  it("resolves /goto links once each; a miss or a throw is a null url", async () => {
    const { resolve, asked } = resolverOf({
      "https://www.google.com/goto?url=A": "https://a.test/",
    });
    const serp = await serpOf(
      "q",
      [
        page({
          results: [result("/goto?url=A"), result("/goto?url=MISS"), result("/goto?url=boom")],
          ads: [{ title: "ad", href: "/goto?url=A", shown: "a.test" }],
        }),
      ],
      10,
      resolve,
    );
    expect(serp.results.map((r) => r.url)).toEqual(["https://a.test/", null, null]);
    expect(serp.ads).toEqual([{ title: "ad", shown: "a.test", url: "https://a.test/" }]);
    // The same href is asked once, shared by the result and the ad.
    expect(asked.filter((a) => a.endsWith("url=A"))).toHaveLength(1);
  });

  it("resolves ads from every page and overview sources from the first", async () => {
    const { resolve } = resolverOf({
      "https://www.google.com/aclk?ai=1": "https://ad1.test/",
      "https://www.google.com/aclk?ai=2": "https://ad2.test/",
      "https://www.google.com/goto?url=S": "https://source.test/",
    });
    const serp = await serpOf(
      "q",
      [
        page({
          overview: { text: "The answer.", sources: [{ title: "Source", href: "/goto?url=S" }] },
          ads: [{ title: "one", href: "/aclk?ai=1", shown: null }],
        }),
        page({
          overview: { text: "ignored", sources: [] },
          ads: [{ title: "two", href: "/aclk?ai=2", shown: null }],
        }),
      ],
      10,
      resolve,
    );
    expect(serp.overview).toEqual({
      text: "The answer.",
      sources: [{ title: "Source", url: "https://source.test/" }],
    });
    expect(serp.ads.map((a) => a.url)).toEqual(["https://ad1.test/", "https://ad2.test/"]);
  });

  it("no overview on the first page is null; no pages at all is an empty serp", async () => {
    const { resolve } = resolverOf({});
    expect((await serpOf("q", [page({})], 10, resolve)).overview).toBeNull();
    expect(await serpOf("q", [], 10, resolve)).toEqual({
      query: "q",
      overview: null,
      results: [],
      ads: [],
      questions: [],
    });
  });

  it("questions dedupe across pages and drop the query itself, any case", async () => {
    const { resolve } = resolverOf({});
    const serp = await serpOf(
      "Best Cold Email Tool",
      [
        page({ questions: ["What is cold email?", "best cold email tool", "Is it legal?"] }),
        page({ questions: ["Is it legal?", "BEST COLD EMAIL TOOL", "How much?"] }),
      ],
      10,
      resolve,
    );
    expect(serp.query).toBe("Best Cold Email Tool");
    expect(serp.questions).toEqual(["What is cold email?", "Is it legal?", "How much?"]);
  });
});

describe("google page script", () => {
  it("parses as an expression", () => {
    expect(() => new Function(`return ${SERP_SCRIPT}`)).not.toThrow();
  });

  it("is served as web/google", () => {
    expect(BROWSER_FLOWS["web/google"]?.name).toBe("google");
  });
});
