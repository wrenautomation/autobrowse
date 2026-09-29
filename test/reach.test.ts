import { describe, expect, it } from "vitest";
import { duckduckgoHits, htmlText, readPage, search, WebMiss } from "../src/reach/web.js";
import { type ApiLeg, SiteError } from "../src/sites/types.js";
import { web } from "../src/sites/web.js";

type Call = { url: string; headers: Record<string, string> };
function fakeFetch(answer: (url: string) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return answer(url);
  }) as typeof fetch;
  return { f, calls };
}
const env = (vars: Record<string, string>) => async (n: string) => vars[n];

describe("read", () => {
  it("jina first; a dead one falls through to a plain fetch, cut to --max", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.startsWith("https://r.jina.ai/")
        ? new Response("busy", { status: 429 })
        : new Response("<title>Acme &amp; Co</title><h1>Hi</h1><p>We plan.</p>", {
            headers: { "content-type": "text/html" },
          }),
    );
    const p = await readPage("https://acme.test/", { env: env({}), fetch: f }, { max: 6 });
    expect(p).toMatchObject({ title: "Acme & Co", via: "fetch", text: "# Hi\nW", cut: 7 });
    expect(p.tried).toEqual([{ via: "jina", why: "Error: HTTP 429" }]);
    expect(calls[0]?.url).toBe("https://r.jina.ai/https://acme.test/");
  });

  it("a URL carrying a credential never goes to jina", async () => {
    const { f, calls } = fakeFetch(
      () => new Response("ok", { headers: { "content-type": "text/plain" } }),
    );
    const p = await readPage("https://x.test/?token=abc", { env: env({}), fetch: f });
    expect(p.via).toBe("fetch");
    expect(calls.map((c) => c.url)).toEqual(["https://x.test/?token=abc"]);
  });

  it("html to text: scripts gone, headings and list items kept, entities decoded", () => {
    expect(
      htmlText("<script>x()</script><h2>Team</h2><ul><li>Ann &#x27;A&#39;</li><li>Bo</li></ul>")
        .text,
    ).toBe("## Team\n\n- Ann 'A'\n- Bo");
  });
});

describe("search", () => {
  it("skips a backend with no key; the key goes in a header", async () => {
    const { f, calls } = fakeFetch(() =>
      Response.json({
        web: { results: [{ title: "<b>A</b>", url: "https://a.test", description: "d" }] },
      }),
    );
    const r = await search("ria austin", { env: env({ BRAVE_API_KEY: "k1" }), fetch: f });
    expect(r).toMatchObject({
      via: "brave",
      hits: [{ title: "A", url: "https://a.test", snippet: "d" }],
    });
    expect(r.tried).toEqual([{ via: "exa", why: "skipped: no EXA_API_KEY" }]);
    expect(calls[0]?.url).not.toContain("k1");
    expect(calls[0]?.headers["X-Subscription-Token"]).toBe("k1");
  });

  it("nothing answering is final: 502 when backends failed, 501 when all lacked keys, 400 for an unknown one", async () => {
    const { f } = fakeFetch(() => new Response("bot check", { status: 403 }));
    const miss = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => e as WebMiss,
      );
    const failed = await miss(search("q", { env: env({ BRAVE_API_KEY: "k" }), fetch: f }));
    expect(failed).toBeInstanceOf(WebMiss);
    expect(failed?.status).toBe(502);
    expect(
      (await miss(search("q", { env: env({}), fetch: f }, { order: ["exa", "brave"] })))?.status,
    ).toBe(501);
    expect((await miss(search("q", { env: env({}), fetch: f }, { order: ["bing"] })))?.status).toBe(
      400,
    );
    // Through the site: a SiteError, which the Restate face makes terminal (no endless retry).
    const leg = { token: "", http: {} as ApiLeg["http"], env: () => undefined } as ApiLeg;
    const api = web.routes[0]?.api as (i: unknown, l: ApiLeg) => Promise<unknown>;
    const err = await api({ q: "q", n: 5, via: ["exa", "brave"] }, leg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteError);
    expect((err as SiteError).status).toBe(501);
  });

  it("reads DuckDuckGo's html results, ads left out", () => {
    const html = `
      <div class="result result--ad"><a class="result__a" href="https://ad.test">Ad</a></div>
      <div class="result results_links"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flakehills.test%2F&amp;rut=1">Lake <b>Hills</b></a>
      <a class="result__snippet" href="x">Fee-only &amp; fiduciary</a></div>`;
    expect(duckduckgoHits(html)).toEqual([
      { title: "Lake Hills", url: "https://lakehills.test/", snippet: "Fee-only & fiduciary" },
    ]);
  });
});
