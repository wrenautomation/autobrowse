import { describe, expect, it } from "vitest";
import type { FlowRunner } from "../src/browser/flow.js";
import {
  aboutFieldsOf,
  companyIdOf,
  companyOf,
  connectionOf,
  jobCardsOf,
  jobsOf,
  linkedinConnect,
  linkedinWithdraw,
  type Person,
  type Profile,
  personOf,
  pickRole,
  profileOf,
  rolesOf,
  searchUrl,
} from "../src/browser/flows/linkedin-reach.js";
import type { Hints } from "../src/browser/locate.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { LEAD_COLUMNS, writeLeads } from "../src/reach/linkedin-leads.js";
import { siteFacade } from "../src/sites/facade.js";
import { linkedin } from "../src/sites/linkedin.js";
import { fakePage } from "./auth-fakes.js";
import { fakeFetch } from "./fakes.js";

const line = (a: { op: { kind: string }; hints: Hints }) =>
  `${a.op.kind} ${a.hints.name ?? a.hints.css}`;

describe("linkedin reach: reading rows", () => {
  it("a search row: name, degree, headline, location, the role that matched", () => {
    expect(
      personOf({
        text: "Clay Howell • 3rd+\n\n3rd+ degree connection\nFounder, Lake Hills Wealth\nAustin, Texas\nConnect\nCurrent: Founder at Lake Hills Wealth\n12 mutual connections",
        links: [
          "https://www.linkedin.com/in/clay-howell-17618bb0?miniProfileUrn=x",
          "https://www.linkedin.com/in/clay-howell-17618bb0?miniProfileUrn=x",
        ],
      }),
    ).toEqual({
      name: "Clay Howell",
      vanity: "clay-howell-17618bb0",
      url: "https://www.linkedin.com/in/clay-howell-17618bb0/",
      degree: "3rd+",
      headline: "Founder, Lake Hills Wealth",
      location: "Austin, Texas",
      current: "Founder at Lake Hills Wealth",
    });
  });

  it("a company card has no location; an out-of-network member is no lead", () => {
    expect(
      personOf({
        text: "Andrew Bitar\nDirector, Compiler Engineering @ NVIDIA\nConnect",
        links: ["https://www.linkedin.com/in/andrewbitar"],
      }),
    ).toMatchObject({ name: "Andrew Bitar", headline: "Director, Compiler Engineering @ NVIDIA" });
    expect(personOf({ text: "LinkedIn Member\nAdvisor", links: ["https://x.test/in/x"] })).toBe(
      null,
    );
  });

  it("a profile's top card, above Contact info", () => {
    expect(
      profileOf(
        "clay-howell-17618bb0",
        "Clay Howell\n· 2nd\nFounder, Lake Hills Wealth\nAustin, Texas, United States\nContact info\nLake Hills Wealth\nUT Austin\n500+ connections\nConnect\nMessage",
        "About\nFee-only planning for families.\n…see more",
      ),
    ).toEqual({
      name: "Clay Howell",
      vanity: "clay-howell-17618bb0",
      url: "https://www.linkedin.com/in/clay-howell-17618bb0/",
      degree: "2nd",
      headline: "Founder, Lake Hills Wealth",
      location: "Austin, Texas, United States",
      connections: "500+",
      about: "Fee-only planning for families.",
    });
  });

  it("search URLs carry the network filter as LinkedIn writes it", () => {
    expect(searchUrl({ keywords: "ria founder", network: ["S", "O"] }, 2)).toBe(
      "https://www.linkedin.com/search/results/people/?keywords=ria+founder&network=%5B%22S%22%2C%22O%22%5D&page=2",
    );
  });
});

describe("linkedin reach: connect", () => {
  it("with a note: add, type, send (the send is irreversible), notes left", async () => {
    const { fp, acts } = fakePage({
      text: ["", "4 personalized invitations remaining for this month", "Invitation sent"],
      present: (h) => h.name !== "/^don.t allow$/i",
    });
    const irreversible: boolean[] = [];
    const act = fp.act.bind(fp);
    fp.act = async (op, hints, o) => {
      irreversible.push(Boolean(o.irreversible));
      return act(op, hints, o);
    };
    const out = await linkedinConnect.run(fp, { vanity: "clay-howell-17618bb0", note: "hi Clay" });
    expect(acts.map(line)).toEqual([
      "click /^add a note$/i",
      "fill textarea#custom-message, textarea[name=message]",
      "click /^send( invitation)?$/i",
    ]);
    expect(irreversible).toEqual([false, false, true]);
    expect(out).toEqual({ sent: true, note: true, notesLeft: 3 });
  });

  it("no invite dialog (pending, connected, Follow only): a person decides, nothing sent", async () => {
    const { fp, acts } = fakePage({ text: [""], present: () => false });
    await expect(linkedinConnect.run(fp, { vanity: "x-y" })).rejects.toThrow(/no invite dialog/);
    expect(acts).toEqual([]);
  });
});

describe("linkedin reach: connections and withdraw", () => {
  it("a recently added card: the person, and when they connected kept off the headline", () => {
    expect(
      connectionOf({
        text: "Dana Ruiz\nFounder, Ruiz Search Partners\nConnected on October 5, 2026\nMessage",
        links: ["https://www.linkedin.com/in/dana-ruiz-4b1/"],
      }),
    ).toEqual({
      name: "Dana Ruiz",
      vanity: "dana-ruiz-4b1",
      url: "https://www.linkedin.com/in/dana-ruiz-4b1/",
      headline: "Founder, Ruiz Search Partners",
      connected: "Connected on October 5, 2026",
    });
  });

  const withButtons = (reads: string[][]) => {
    const { fp, acts } = fakePage({ text: [""], present: (h) => h.name !== "/^don.t allow$/i" });
    let n = 0;
    fp.page = {
      evaluate: async () => ({ buttons: reads[Math.min(n++, reads.length - 1)], degree: null }),
    } as unknown as typeof fp.page;
    return { fp, acts };
  };

  it("pending: Pending, then Withdraw (irreversible), then reads none", async () => {
    const { fp, acts } = withButtons([["Pending, click to withdraw"], ["Connect"]]);
    const out = await linkedinWithdraw.run(fp, { vanity: "dana-ruiz-4b1" });
    expect(acts.map(line)).toEqual(["click /^pending/i", "click /^withdraw$/i"]);
    expect(out).toEqual({ withdrawn: true, relationship: "none" });
  });

  it("already connected: withdraws nothing and says so", async () => {
    const { fp, acts } = withButtons([["Message", "More"]]);
    expect(await linkedinWithdraw.run(fp, { vanity: "dana-ruiz-4b1" })).toEqual({
      withdrawn: false,
      relationship: "connected",
    });
    expect(acts).toEqual([]);
  });
});

describe("linkedin reach: routes", () => {
  const sites = (profile: string | null, seen: string[]) => {
    const runner: FlowRunner = {
      async run(flow, input) {
        seen.push(`${flow.site} ${flow.name} ${JSON.stringify(input)}`);
        return { people: [] } as never;
      },
    };
    return siteFacade([linkedin], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner,
      flow: (n) => BROWSER_FLOWS[n] ?? null,
      providerOf: () => null,
      accountFor: async () => "hello@wren.test",
      profileFor: async (site) => profile && `${site}@${profile}`,
    });
  };

  it("every reach route is a registered flow; sends say irreversible", () => {
    const reach = linkedin.routes.filter((r) => r.browser && "flow" in r.browser);
    for (const r of reach)
      expect(BROWSER_FLOWS[(r.browser as { flow: string }).flow], r.path).toBeDefined();
    const sends = reach.filter((r) => r.irreversible).map((r) => r.path);
    expect(sends).toEqual([
      "/rest/posts",
      "/in/{vanity}/connect",
      "/in/{vanity}/withdraw",
      "/in/{vanity}/message",
    ]);
  });

  it("runs in the policy account's own profile, never the bare one", async () => {
    const seen: string[] = [];
    await sites("wren", seen).call(
      "linkedin",
      "GET",
      "/search/results/people?keywords=ria%20austin&network=S,O",
      {},
    );
    expect(seen).toEqual([
      'linkedin@wren search-people {"keywords":"ria austin","page":1,"pages":1,"network":["S","O"]}',
    ]);
  });

  it("refuses when no profile signs in as the chosen account", async () => {
    const seen: string[] = [];
    await expect(
      sites(null, seen).call("linkedin", "GET", "/in/clay-howell-17618bb0", {}),
    ).rejects.toMatchObject({ status: 409 });
    expect(seen).toEqual([]);
  });

  it("a note over 200 characters is refused before any browser opens", async () => {
    const seen: string[] = [];
    await expect(
      sites("wren", seen).call("linkedin", "POST", "/in/clay-howell-17618bb0/connect", {
        note: "x".repeat(201),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(seen).toEqual([]);
  });
});

describe("linkedin reach: roles, company, leads", () => {
  it("experience entries: single roles, and a company's grouped roles under its header", () => {
    const roles = rolesOf(
      [
        {
          lines: [
            "Chief Executive Officer",
            "Skyline Wealth Strategies LLC · Full-time",
            "Apr 2023 - Sep 2026 · 3 yrs 6 mos",
            "Austin, Texas, United States · On-site",
          ],
          href: "https://www.linkedin.com/company/81997192/?x=1",
        },
        {
          lines: ["AIG Retirement Services", "5 yrs 2 mos"],
          href: "https://www.linkedin.com/company/19057362/",
        },
        {
          lines: [
            "Vice President, Field Development",
            "Full-time",
            "Nov 2018 - Jul 2021 · 2 yrs 9 mos",
            "Houston, Texas Area",
          ],
          href: "https://www.linkedin.com/company/19057362/",
        },
      ],
      new Date(2026, 8, 25),
    );
    expect(roles).toEqual([
      {
        title: "Chief Executive Officer",
        company: "Skyline Wealth Strategies LLC",
        companyUrl: "https://www.linkedin.com/company/81997192/",
        dates: "Apr 2023 - Sep 2026",
        location: "Austin, Texas, United States",
        current: true,
      },
      {
        title: "Vice President, Field Development",
        company: "AIG Retirement Services",
        companyUrl: "https://www.linkedin.com/company/19057362/",
        dates: "Nov 2018 - Jul 2021",
        location: "Houston, Texas Area",
        current: false,
      },
    ]);
  });

  it("an About page: the handle it redirected to, first line of each value", () => {
    expect(
      companyOf(
        "https://www.linkedin.com/company/skyline-wealth-strategies-llc/about/",
        "Skyline Wealth Strategies LLC ",
        {
          Website: "http://www.skylinewealth.com",
          Phone: "512-555-0100\nPhone number is 512-555-0100",
          "Company size": "2-10 employees",
          Headquarters: "Austin, Texas",
        },
      ),
    ).toEqual({
      name: "Skyline Wealth Strategies LLC",
      handle: "skyline-wealth-strategies-llc",
      url: "https://www.linkedin.com/company/skyline-wealth-strategies-llc/",
      website: "http://www.skylinewealth.com",
      phone: "512-555-0100",
      size: "2-10 employees",
      headquarters: "Austin, Texas",
    });
  });

  it("leads: header once, enriched rows, a miss still written, a re-run skips who is there", async () => {
    const a: Person = {
      name: "Ann Lee",
      vanity: "ann-lee",
      url: "https://www.linkedin.com/in/ann-lee/",
      current: "Founder at Lee Wealth",
      headline: "CFP",
    };
    const b: Person = {
      name: "Bo Diaz",
      vanity: "bo-diaz",
      url: "https://www.linkedin.com/in/bo-diaz/",
      headline: "Advisor",
    };
    let file = "";
    const misses: string[] = [];
    const deps = (existing: string | null) => ({
      people: async () => [a, b],
      enrich: async ({ vanity: v }: Person): Promise<Profile> => {
        if (v === "bo-diaz") throw new Error("no profile");
        return {
          name: "Ann Lee",
          vanity: v,
          url: a.url,
          company: {
            name: "Lee Wealth, LLC",
            handle: "lee-wealth",
            url: "https://www.linkedin.com/company/lee-wealth/",
            website: "https://leewealth.test",
          },
        };
      },
      existing,
      append: (t: string) => {
        file += t;
      },
      onMiss: (v: string) => misses.push(v),
    });
    expect(await writeLeads(deps(null), 10)).toEqual({ written: 2, skipped: 0 });
    const lines = file.trim().split("\n");
    expect(lines[0]).toBe(LEAD_COLUMNS.join(","));
    expect(lines[1]).toBe(
      'Ann Lee,Founder,"Lee Wealth, LLC",https://leewealth.test,,https://www.linkedin.com/in/ann-lee/,CFP,https://www.linkedin.com/company/lee-wealth/,,,,,linkedin',
    );
    expect(lines[2]).toMatch(/^Bo Diaz,Advisor,,,/);
    expect(misses).toEqual(["bo-diaz"]);
    expect(await writeLeads(deps(file), 10)).toEqual({ written: 0, skipped: 2 });
  });
});

describe("linkedin reach: which role", () => {
  const role = (title: string, company: string, current: boolean) => ({
    title,
    company,
    companyUrl: `https://www.linkedin.com/company/${company.length}/`,
    current,
  });
  it("the current role the headline names beats the first current one", () => {
    const roles = [
      role("Hospitalist", "St. David's HealthCare", true),
      role("Founder and CEO", "Austin Regenerative Therapy", true),
      role("Resident", "UT Health", false),
    ];
    expect(
      pickRole(roles, [undefined, "Founder and CEO at Austin Regenerative Therapy"])?.title,
    ).toBe("Founder and CEO");
    expect(pickRole(roles, [])?.title).toBe("Hospitalist");
    expect(pickRole([role("Resident", "UT Health", false)], [])?.title).toBe("Resident");
  });
});

describe("company about", () => {
  it("reads labels and values from the page text, under Overview", () => {
    const text = [
      "Stripe",
      "Technology, Information and Internet",
      "Overview",
      "Stripe builds programmable financial services.",
      "Website",
      "https://stripe.com",
      "Verified page",
      "August 15, 2023",
      "Company size",
      "5,001-10,000 employees",
      "15,705 associated members",
      "Headquarters",
      "South San Francisco, California",
      "Founded",
      "2010",
    ].join("\n\n");
    expect(aboutFieldsOf(text)).toEqual({
      Website: "https://stripe.com",
      "Company size": "5,001-10,000 employees",
      Headquarters: "South San Francisco, California",
      Founded: "2010",
    });
    expect(
      companyOf("https://www.linkedin.com/company/stripe/about/", "Stripe", aboutFieldsOf(text)),
    ).toMatchObject({ handle: "stripe", website: "https://stripe.com", founded: "2010" });
  });
});

describe("company jobs", () => {
  it("reads the numeric id from the jobs or employees link", () => {
    const about = "https://www.linkedin.com/company/stripe/about/";
    expect(
      companyIdOf(about, [
        "https://www.linkedin.com/company/stripe/",
        "https://www.linkedin.com/search/results/people/?currentCompany=%5B%222135371%22%5D",
      ]),
    ).toBe("2135371");
    expect(companyIdOf("https://www.linkedin.com/jobs/search/?f_C=42&geoId=1", [])).toBe("42");
    expect(companyIdOf(about, [about])).toBeNull();
  });

  it("reads cards from the public list's HTML", () => {
    const li = (id: string, title: string) =>
      `<li> <div class="base-card relative base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:${id}" data-row="1"> <a class="base-card__full-link absolute" href="https://ca.linkedin.com/jobs/view/x-${id}?position=1&amp;pageNum=0"> <span class="sr-only"> ${title} </span> </a> <div class="base-search-card__info"> <h3 class="base-search-card__title"> ${title} </h3> <h4 class="base-search-card__subtitle"> <a class="hidden-nested-link" href="https://www.linkedin.com/company/stripe?trk=x"> Stripe </a> </h4> <div class="base-search-card__metadata"> <span class="job-search-card__location"> Toronto, Ontario, Canada </span> <time class="job-search-card__listdate" datetime="2026-09-21"> 1 week ago </time> </div> </div> </div> </li>`;
    expect(
      jobCardsOf(`${li("1", "Risk &amp; Compliance")}\n${li("2", "Engineer &#39;Payments&#x27;")}`),
    ).toEqual([
      {
        urn: "urn:li:jobPosting:1",
        title: " Risk & Compliance ",
        company: "  Stripe ",
        location: " Toronto, Ontario, Canada ",
        datetime: "2026-09-21",
      },
      {
        urn: "urn:li:jobPosting:2",
        title: " Engineer 'Payments' ",
        company: "  Stripe ",
        location: " Toronto, Ontario, Canada ",
        datetime: "2026-09-21",
      },
    ]);
    expect(jobCardsOf("")).toEqual([]);
  });

  it("a card's text decodes every named entity and survives a bad code point", () => {
    const card = (title: string) =>
      `<li> <div data-entity-urn="urn:li:jobPosting:9"> <h3 class="base-search-card__title">${title}</h3> </div> </li>`;
    expect(jobCardsOf(card("Caf&eacute; &mdash; Lead"))[0]?.title).toBe("Café — Lead");
    expect(jobCardsOf(card("A &#99999999; B"))[0]?.title).toBe("A \uFFFD B");
  });

  it("shapes cards once each, whitespace squashed, dates only when they are dates", () => {
    const card = {
      urn: "urn:li:jobPosting:4469959807",
      title: "\n   Manager, Global Sanctions\n ",
      company: "  Stripe ",
      location: " Toronto, Ontario, Canada ",
      datetime: "2026-09-21",
    };
    expect(
      jobsOf([
        card,
        { ...card, title: "dupe" },
        { ...card, urn: "urn:li:jobPosting:1", company: "", location: "", datetime: "1 week ago" },
        { ...card, urn: "urn:li:fsd_company:2" },
      ]),
    ).toEqual([
      {
        id: "4469959807",
        title: "Manager, Global Sanctions",
        url: "https://www.linkedin.com/jobs/view/4469959807/",
        company: "Stripe",
        location: "Toronto, Ontario, Canada",
        postedAt: "2026-09-21",
      },
      {
        id: "1",
        title: "Manager, Global Sanctions",
        url: "https://www.linkedin.com/jobs/view/1/",
      },
    ]);
  });
});
