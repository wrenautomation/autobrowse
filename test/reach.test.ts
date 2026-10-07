import { describe, expect, it } from "vitest";
import {
  cachedLinkedinCompany,
  cachedLinkedinProfile,
  cachedProfile,
  companies,
  companySearch,
  duckduckgoHits,
  exaCompany,
  exaProfile,
  htmlText,
  linkedinPosts,
  linkedinSlug,
  people,
  readPage,
  search,
  WebMiss,
} from "../src/reach/web.js";
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

  it("html to text: every named entity, each decoded once, a bad code point survives", () => {
    expect(htmlText("<p>Caf&eacute; &mdash; it&rsquo;s &euro;5 &copy;</p>").text).toBe(
      "Café — it’s €5 ©",
    );
    // `&amp;lt;` is the text `&lt;`, not `<`.
    expect(htmlText("<p>&amp;lt;b&amp;gt; &amp;#39;</p>").text).toBe("&lt;b&gt; &#39;");
    expect(htmlText("<title>A &#99999999; B</title><p>x</p>").title).toBe("A \uFFFD B");
  });

  it("html to text: a table row reads across", () => {
    expect(
      htmlText(
        "<table><thead><tr><th>Plan</th> <th>Price</th></tr></thead><tr><td>Pro</td><td>$40</td></tr></table>",
      ).text,
    ).toBe("Plan | Price\nPro | $40");
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

describe("people", () => {
  const PROFILE = [
    "# Dana Ruiz",
    "",
    "Head of Talent at Northwind",
    "",
    "Denver, Colorado, United States (US)",
    "",
    "500 connections • 1,200 followers",
    "",
    "## About",
    "",
    "Head of Talent at Northwind",
    "",
    "## Experience",
    "",
    "### [Northwind](https://www.linkedin.com/company/northwind)",
    "",
    "#### Head of Talent (Current)",
    "",
    "Jan 2025 - Present (1 year and 8 months) in Denver",
    "",
    "- Leads a team of 12 recruiters",
    "",
    "#### Recruiting Manager",
    "",
    "Mar 2021 - Jan 2025 (3 years and 10 months)",
    "",
    "### Senior Recruiter - Contoso Staffing",
    "",
    "2018 - 2021 (3 years)",
    "",
    "## Education",
    "",
    "### University of Colorado",
  ].join("\n");

  it("reads a profile: headline, location, every role with its company and dates", () => {
    expect(exaProfile(PROFILE)).toEqual({
      name: "Dana Ruiz",
      headline: "Head of Talent at Northwind",
      location: "Denver, Colorado, United States (US)",
      connections: "500",
      about: "Head of Talent at Northwind",
      roles: [
        {
          title: "Head of Talent",
          company: "Northwind",
          companyUrl: "https://www.linkedin.com/company/northwind",
          current: true,
          dates: "Jan 2025 - Present (1 year and 8 months) in Denver",
        },
        {
          title: "Recruiting Manager",
          company: "Northwind",
          companyUrl: "https://www.linkedin.com/company/northwind",
          current: false,
          dates: "Mar 2021 - Jan 2025 (3 years and 10 months)",
        },
        {
          title: "Senior Recruiter",
          company: "Contoso Staffing",
          companyUrl: null,
          current: false,
          dates: "2018 - 2021 (3 years)",
        },
      ],
      education: [{ school: "University of Colorado", schoolUrl: null, degree: null, dates: null }],
    });
  });

  it("a single role with a linked company, a hyphen in the title, and no dates line", () => {
    const text = [
      "# Lee Park",
      "Talent Partner",
      "## Experience",
      "### Talent Partner - Tech - [Northwind](https://x.example/c) (Current)",
      "- Hires engineers",
    ].join("\n");
    expect(exaProfile(text)?.roles).toEqual([
      {
        title: "Talent Partner - Tech",
        company: "Northwind",
        companyUrl: "https://x.example/c",
        current: true,
        dates: null,
      },
    ]);
  });

  it("text with no name is no profile", () => {
    expect(exaProfile("just some page")).toBeNull();
  });

  it("asks Exa's people index with the key in a header; no key is final (501)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          results: [
            { url: "https://www.linkedin.com/in/dana", text: PROFILE },
            { url: "https://x.example", text: "no heading" },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    const env = async (k: string) => (k === "EXA_API_KEY" ? "k1" : undefined);
    const out = await people("recruiters at Northwind", { env, fetch: f }, { n: 5 });
    expect(out.people.map((p) => [p.name, p.url])).toEqual([
      ["Dana Ruiz", "https://www.linkedin.com/in/dana"],
    ]);
    // What didn't parse is still kept, whole.
    expect(out.raw).toEqual([
      { url: "https://www.linkedin.com/in/dana", text: PROFILE },
      { url: "https://x.example", text: "no heading" },
    ]);
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent).toMatchObject({
      query: "recruiters at Northwind",
      category: "people",
      numResults: 5,
    });
    expect(calls[0]?.init.headers).toMatchObject({ "x-api-key": "k1" });
    await expect(people("q", { env: async () => undefined, fetch: f })).rejects.toMatchObject({
      status: 501,
    });
  });
});

describe("linkedin pages from exa's cache", () => {
  const PROFILE = [
    "# Avery Quinlan",
    "",
    "Founder at Northwind Talent",
    "",
    "Austin, Texas, United States (US)",
    "",
    "312 connections • 400 followers",
    "",
    "## About",
    "",
    "I place engineers at startups.",
    "",
    "| Fact | Value |",
    "| --- | --- |",
    "| Born | 1990 |",
    "",
    "## Experience",
    "",
    "### Founder - [Northwind Talent](https://www.linkedin.com/company/northwind-talent) (Current)",
    "",
    "Mar 2022 - Present (3 years and 7 months) in Austin, Texas",
    "",
    "### Recruiter - Contoso Staffing",
    "",
    "2018 - 2022 (4 years)",
    "",
    "## Education",
    "",
    "### BSc, Computer Science - [Example State University](https://www.linkedin.com/school/example-state)",
    "",
    "2010 - 2014 (4 years) in Springfield",
    "",
    "### Lakeview High",
    "",
    "Springfield, United States",
  ].join("\n");

  const COMPANY = [
    "# Northwind Talent",
    "",
    "Northwind Talent is a Staffing and Recruiting company. Northwind Talent employs 14 people, founded in 2019.",
    "",
    "## About",
    "",
    "We find engineers for seed-stage startups.",
    "",
    "## Company Details",
    "- Industry: Staffing and Recruiting",
    "- Type: Privately held",
    "- Headquarters: Austin, United States",
    "- Founded Year: 2019",
    "- Homepage: northwind-talent.example",
    "- LinkedIn: linkedin.com/company/northwind-talent",
    "- Phone: +1 555 0100",
    "",
    "## Workforce",
    "- Company Size: 11-50 employees",
  ].join("\n");

  it("a profile in the linkedin site's shape: dates as LinkedIn prints them, places apart, schools", () => {
    expect(cachedProfile(PROFILE, "avery-q", "cached")).toEqual({
      name: "Avery Quinlan",
      vanity: "avery-q",
      url: "https://www.linkedin.com/in/avery-q/",
      headline: "Founder at Northwind Talent",
      location: "Austin, Texas, United States",
      connections: "312",
      about: "I place engineers at startups.",
      roles: [
        {
          title: "Founder",
          company: "Northwind Talent",
          companyUrl: "https://www.linkedin.com/company/northwind-talent",
          dates: "Mar 2022 - Present",
          location: "Austin, Texas",
          current: true,
        },
        { title: "Recruiter", company: "Contoso Staffing", dates: "2018 - 2022", current: false },
      ],
      education: [
        {
          school: "Example State University",
          schoolUrl: "https://www.linkedin.com/school/example-state",
          degree: "BSc, Computer Science",
          dates: "2010 - 2014",
          location: "Springfield",
        },
        { school: "Lakeview High" },
      ],
      text: PROFILE,
      source: "cached",
    });
  });

  it("a company: details, size, employees off the intro, homepage with a scheme, its handle", () => {
    expect(exaCompany(COMPANY)).toEqual({
      name: "Northwind Talent",
      website: "https://northwind-talent.example",
      phone: "+1 555 0100",
      industry: "Staffing and Recruiting",
      size: "11-50 employees",
      headquarters: "Austin, United States",
      founded: "2019",
      type: "Privately held",
      employees: 14,
      about: "We find engineers for seed-stage startups.",
      handle: "northwind-talent",
    });
    expect(exaCompany("no heading")).toBeNull();
  });

  it("takes any LinkedIn host and form; anything else is a 400", () => {
    expect(linkedinSlug("https://ca.linkedin.com/in/avery-q/?trk=x", "in")).toBe("avery-q");
    expect(linkedinSlug("linkedin.com/company/northwind-talent/about", "company")).toBe(
      "northwind-talent",
    );
    for (const bad of ["https://acme.com/in/avery", "linkedin.com/company/x", "nonsense url"])
      expect(() => linkedinSlug(bad, "in")).toThrow(WebMiss);
  });

  const exa = (answer: unknown) => {
    const sent: unknown[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(answer));
    }) as unknown as typeof fetch;
    return { deps: { env: async () => "k", fetch: f }, sent };
  };

  it("asks for the canonical page, never live; a page Exa lacks is a 404", async () => {
    const hit = exa({
      results: [{ text: PROFILE }],
      statuses: [{ status: "success", source: "cached" }],
    });
    const p = await cachedLinkedinProfile("uk.linkedin.com/in/avery-q?trk=a", hit.deps);
    expect(p.roles).toHaveLength(2);
    expect(hit.sent[0]).toMatchObject({
      urls: ["https://www.linkedin.com/in/avery-q"],
      livecrawl: "never",
    });
    const miss = exa({
      results: [],
      statuses: [{ status: "error", error: { httpStatusCode: 404, tag: "ENTITY_NOT_FOUND" } }],
    });
    await expect(
      cachedLinkedinCompany("linkedin.com/company/nobody-here", miss.deps),
    ).rejects.toMatchObject({ status: 404 });
    const other = exa({ results: [], statuses: [{ status: "error", error: { tag: "TIMEOUT" } }] });
    await expect(
      cachedLinkedinCompany("linkedin.com/company/nobody-here", other.deps),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("a company page keeps the handle Exa names, and the linkedin shape's url", async () => {
    const { deps } = exa({
      results: [{ text: COMPANY }],
      statuses: [{ status: "success", source: "cached" }],
    });
    const c = await cachedLinkedinCompany("https://www.linkedin.com/company/12345", deps);
    expect(c).toMatchObject({
      handle: "northwind-talent",
      url: "https://www.linkedin.com/company/northwind-talent/",
      text: COMPANY,
    });
  });

  it("company search by domain: its LinkedIn page, and whether the homepage is that domain", async () => {
    const { deps, sent } = exa({
      results: [
        { url: "https://northwind-talent.example/", text: COMPANY },
        {
          url: "https://www.linkedin.com/company/northwind-labs",
          text: "# Northwind Labs\n\n## Company Details\n- Homepage: northwind-labs.example",
        },
      ],
    });
    const out = await companies("https://www.Northwind-Talent.example/team", deps);
    expect(out.domain).toBe("northwind-talent.example");
    expect(out.companies.map((c) => [c.name, c.linkedin, c.homepageMatches])).toEqual([
      ["Northwind Talent", "https://www.linkedin.com/company/northwind-talent/", true],
      ["Northwind Labs", null, false],
    ]);
    expect(sent[0]).toMatchObject({ query: "northwind-talent.example", category: "company" });
  });

  it("firm search: one company-category search, every result whole, no page text", async () => {
    const hit = {
      id: "r1",
      title: "Northwind Talent",
      url: "https://www.Northwind-Talent.example/about",
      score: 0.9,
    };
    const { deps, sent } = exa({
      requestId: "req-1",
      costDollars: { total: 0.007 },
      results: [
        hit,
        { id: "r2", title: null, url: "https://www.linkedin.com/company/acme-staffing" },
        { id: "r3", title: "no url" },
      ],
    });
    const out = await companySearch("staffing agency in Austin", deps, { n: 3 });
    expect(sent).toEqual([
      { query: "staffing agency in Austin", category: "company", numResults: 3, type: "auto" },
    ]);
    expect(out.results).toEqual([
      { url: hit.url, title: "Northwind Talent", domain: "northwind-talent.example", raw: hit },
      {
        url: "https://www.linkedin.com/company/acme-staffing",
        title: null,
        domain: "linkedin.com",
        raw: { id: "r2", title: null, url: "https://www.linkedin.com/company/acme-staffing" },
      },
    ]);
    expect(out.meta).toEqual({ requestId: "req-1", costDollars: { total: 0.007 } });
  });

  it("linkedin posts: one search limited to linkedin.com/posts, text cut, other urls dropped", async () => {
    const post = {
      id: "p1",
      url: "https://www.linkedin.com/posts/avery-q_hiring-update-activity-7380000000000000000-AbCd",
      title: "Hiring update",
      author: "Avery Quinlan",
      publishedDate: "2026-09-30T00:00:00.000Z",
      text: "We placed ten engineers this quarter.",
    };
    const { deps, sent } = exa({
      results: [post, { id: "p2", url: "https://www.linkedin.com/in/avery-q" }, { id: "p3" }],
    });
    const out = await linkedinPosts("Avery Quinlan Northwind", deps, { n: 5, since: "2026-07-01" });
    expect(sent).toEqual([
      {
        query: "Avery Quinlan Northwind",
        includeDomains: ["linkedin.com/posts"],
        numResults: 5,
        type: "auto",
        startPublishedDate: "2026-07-01",
        contents: { text: { maxCharacters: 2000 } },
      },
    ]);
    expect(out).toEqual({
      query: "Avery Quinlan Northwind",
      via: "exa",
      posts: [
        {
          url: post.url,
          title: "Hiring update",
          author: "Avery Quinlan",
          publishedDate: "2026-09-30T00:00:00.000Z",
          text: "We placed ten engineers this quarter.",
          raw: post,
        },
      ],
    });
  });
});
