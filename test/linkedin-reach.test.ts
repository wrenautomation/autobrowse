import { describe, expect, it } from "vitest";
import type { FlowRunner } from "../src/browser/flow.js";
import {
  linkedinConnect,
  personOf,
  profileOf,
  searchUrl,
} from "../src/browser/flows/linkedin-reach.js";
import type { Hints } from "../src/browser/locate.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
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
    expect(sends).toEqual(["/rest/posts", "/in/{vanity}/connect", "/in/{vanity}/message"]);
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
