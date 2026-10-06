import { describe, expect, it } from "vitest";
import type { FlowRunner } from "../src/browser/flow.js";
import {
  ageAt,
  linkedinNotifications,
  notificationOf,
  type RawNotification,
} from "../src/browser/flows/linkedin-notifications.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { siteFacade } from "../src/sites/facade.js";
import { linkedin } from "../src/sites/linkedin.js";
import { fakePage } from "./auth-fakes.js";
import { fakeFetch } from "./fakes.js";

// Synthetic cards in the shape the page script returns (mapped 2026-10-06); no real people.
const IN = "https://www.linkedin.com/in/";
const card = (text: string, links: string[], bold: string[]): RawNotification => ({
  text,
  links,
  bold,
});
const CARDS: RawNotification[] = [
  card(
    "Dana Ruiz reacted to your post: Hiring is slow in Q4.\n\n2h",
    [`${IN}dana-ruiz-test/`, "https://www.linkedin.com/feed/update/urn:li:activity:1001/"],
    ["Dana Ruiz"],
  ),
  card(
    "Lee Park commented on your post: Agreed, same here.\n\n5h",
    [`${IN}lee-park-test/`, "https://www.linkedin.com/feed/update/urn:li:activity:1001/"],
    ["Lee Park"],
  ),
  card(
    "Sam Ortiz mentioned you in a comment.\n\n1d",
    [`${IN}sam-ortiz-test/`, "https://www.linkedin.com/feed/update/urn:li:activity:1002/"],
    ["Sam Ortiz"],
  ),
  card(
    "Kim Vale started following you.\n\n2d",
    [`${IN}kim-vale-test/?miniProfileUrn=x`, `${IN}kim-vale-test/`],
    ["Kim Vale"],
  ),
  card(
    "Ana Wu accepted your invitation to connect.\n\n3d",
    [`${IN}ana-wu-test/`, `${IN}ana-wu-test/`],
    ["Ana Wu"],
  ),
  card(
    "Ray Lund viewed your profile. See all views.\n\nPowered by Premium\n\n1w",
    [`${IN}ray-lund-test/`, "https://www.linkedin.com/analytics/profile-views/"],
    ["Ray Lund"],
  ),
  card(
    "Congratulate Jo Hart on a new position at Acme Staffing. View more network updates.\n\nSay congrats\n\n2w",
    [
      `${IN}jo-hart-test/`,
      "https://www.linkedin.com/messaging/compose/?recipient=x",
      "https://www.linkedin.com/mynetwork/catch-up/all/?highlightedUrns=y",
    ],
    ["Jo Hart", "Acme Staffing"],
  ),
  card(
    "Suggested for you: A long post about hiring.\n\n12 reactions • 3 comments\n\n3mo",
    [`${IN}someone-test/`, "https://www.linkedin.com/feed/?highlightedUpdateUrn=urn:li:activity:9"],
    ["Suggested for you:"],
  ),
];
const NOW = new Date("2026-10-06T12:00:00.000Z");

describe("linkedin notifications: a card", () => {
  it("reads actor, one-line text, the link it is about, and an approximate time", () => {
    const n = notificationOf(CARDS[0] as RawNotification, NOW);
    expect(n).toMatchObject({
      kind: "reaction",
      actor: "Dana Ruiz",
      actorUrl: `${IN}dana-ruiz-test/`,
      text: "Dana Ruiz reacted to your post: Hiring is slow in Q4.",
      url: "https://www.linkedin.com/feed/update/urn:li:activity:1001/",
      at: "2026-10-06T10:00:00.000Z",
      approx: true,
      raw: CARDS[0],
    });
    expect(n?.id).toMatch(/^h[0-9a-f]{16}$/);
  });

  it("kinds from LinkedIn's words; a message link and a bold label are never the target or actor", () => {
    const all = CARDS.map((c) => notificationOf(c, NOW));
    expect(all.map((n) => n?.kind)).toEqual([
      "reaction",
      "comment",
      "mention",
      "follow",
      "connection",
      "view",
      "other",
      "other",
    ]);
    expect(all[3]?.actorUrl).toBe(`${IN}kim-vale-test/`);
    expect(all[6]?.url).toBe("https://www.linkedin.com/mynetwork/catch-up/all/?highlightedUrns=y");
    expect(all[7]?.actor).toBeUndefined();
    expect(new Set(all.map((n) => n?.id)).size).toBe(CARDS.length);
  });

  it("the id holds across reads as the age label moves; a urn wins when there is one", () => {
    const later = {
      ...(CARDS[0] as RawNotification),
      text: "Dana Ruiz reacted to your post: Hiring is slow in Q4.\n\n3h",
    };
    expect(notificationOf(later, NOW)?.id).toBe(
      notificationOf(CARDS[0] as RawNotification, NOW)?.id,
    );
    expect(notificationOf({ ...later, urn: "urn:li:fs_notification:1" }, NOW)?.id).toBe(
      "urn:li:fs_notification:1",
    );
  });

  it("an empty card is no notification; ages to instants", () => {
    expect(notificationOf(card("\n\n", [], []), NOW)).toBeNull();
    expect(ageAt("now", NOW)).toBe(NOW.toISOString());
    expect(ageAt("1w", NOW)).toBe("2026-09-29T12:00:00.000Z");
    expect(ageAt("Sep 29", NOW)).toBeNull();
  });
});

describe("linkedin notifications: the flow and the route", () => {
  it("scrolls until max, newest first, a card seen twice kept once, and never acts", async () => {
    const { fp, acts } = fakePage({ text: [""], present: (h) => h.name !== "/^don.t allow$/i" });
    const screens = [CARDS.slice(0, 3), CARDS.slice(2, 6)];
    let shown = 0;
    let scrolls = 0;
    fp.scroll = async () => {
      scrolls++;
      shown++;
    };
    fp.page = {
      evaluate: async (fn: unknown) =>
        typeof fn === "string" ? 800 : (screens[Math.min(shown, screens.length - 1)] ?? []),
    } as unknown as typeof fp.page;
    const out = await linkedinNotifications.run(fp, { max: 5 });
    expect(out.notifications.map((n) => n.actor)).toEqual([
      "Dana Ruiz",
      "Lee Park",
      "Sam Ortiz",
      "Kim Vale",
      "Ana Wu",
    ]);
    expect(scrolls).toBe(1);
    expect(acts).toEqual([]);
  });

  it("no list on the page goes to a person", async () => {
    const { fp } = fakePage({ text: [""], present: () => false });
    await expect(linkedinNotifications.run(fp, {})).rejects.toThrow(/no notifications list/);
  });

  it("GET /notifications runs as the named account, max 40 by default, metered 12 a day", async () => {
    const seen: string[] = [];
    const runner: FlowRunner = {
      async run(flow, input) {
        seen.push(`${flow.site} ${flow.name} ${JSON.stringify(input)}`);
        return { notifications: [] } as never;
      },
    };
    const sites = siteFacade([linkedin], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner,
      flow: (n) => BROWSER_FLOWS[n] ?? null,
      providerOf: () => null,
      accountFor: async () => "hello@wren.test",
      profileFor: async (site) => `${site}@wren`,
    });
    expect(await sites.call("linkedin", "GET", "/notifications", {})).toEqual({
      notifications: [],
    });
    expect(seen).toEqual(['linkedin@wren notifications {"max":40}']);
    expect(linkedin.caps).toMatchObject({ notifications: 12 });
    expect(linkedin.accountCaps?.linkedin).toMatchObject({ notifications: 0 });
    expect(linkedin.accountCaps?.["linkedin@alt"]).toMatchObject({ notifications: 0 });
  });
});
