import { describe, expect, it } from "vitest";
import {
  featureOf,
  nameFits,
  placeIdIn,
  placeIdOfHref,
  placeOf,
  placeSearchUrl,
  type RawPlace,
} from "../src/browser/flows/google-place.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { web } from "../src/sites/web.js";

const FEATURE = "0x1111aaaa2222bbbb:0x3333cccc4444dddd";
const PLACE = "ChIJsynthetic_place-0001";
const OTHER = "ChIJsynthetic_place-0002";
const placeUrl = `https://www.google.com/maps/place/Northwind+Plumbing/@1,2,17z/data=!3m1!4b1!4m6!3m5!1s${FEATURE}!8m2`;
const body = `)]}'\n[null,[["${FEATURE}",null,null,"/g/11abc","${PLACE}","123"]],[["0x9:0x8",null,null,"/g/x","${OTHER}"]]]`;

const raw = (p: Partial<RawPlace>): RawPlace => ({
  kind: null,
  name: null,
  address: null,
  links: [],
  ...p,
});

describe("google place", () => {
  it("searches Maps for the line, in English", () => {
    const u = new URL(placeSearchUrl("Northwind Plumbing, 12 Elm St"));
    expect(u.pathname).toBe("/maps/search/");
    expect(u.searchParams.get("query")).toBe("Northwind Plumbing, 12 Elm St");
    expect(u.searchParams.get("hl")).toBe("en");
  });

  it("reads ids off links and URLs", () => {
    expect(placeIdOfHref(`https://www.google.com/maps/place/X/data=!4m7!19s${PLACE}?hl=en`)).toBe(
      PLACE,
    );
    expect(placeIdOfHref("https://www.google.com/maps/place/X/data=!4m7")).toBeNull();
    expect(featureOf(placeUrl)).toBe(FEATURE);
    expect(featureOf("https://www.google.com/maps/search/x")).toBeNull();
  });

  it("pairs the page's feature with its Place ID; one lone id stands alone", () => {
    expect(placeIdIn([body], FEATURE)).toBe(PLACE);
    expect(placeIdIn([body], null)).toBeNull();
    expect(placeIdIn([`"${PLACE}" and "${PLACE}"`], null)).toBe(PLACE);
    expect(placeIdIn([], FEATURE)).toBeNull();
  });

  it("fits a name on more than half the shorter name's words", () => {
    expect(nameFits("Northwind Plumbing", "Northwind Plumbing, 12 Elm St")).toBe(true);
    expect(nameFits("Northwind Coffee Company", "Northwind, 12 Elm St")).toBe(true);
    expect(nameFits("Contoso Plumbing", "Northwind Plumbing, 12 Elm St")).toBe(false);
    expect(nameFits("Fabrikam & Sons", "fabrikam and sons springfield")).toBe(true);
    expect(nameFits("", "Northwind")).toBe(false);
  });

  it("answers a place page with its Place ID", () => {
    const got = placeOf(
      "Northwind Plumbing, 12 Elm St",
      placeUrl,
      raw({ kind: "place", name: "Northwind Plumbing", address: "12 Elm St, Springfield" }),
      [body],
    );
    expect(got).toMatchObject({
      placeId: PLACE,
      name: "Northwind Plumbing",
      address: "12 Elm St, Springfield",
      via: "place",
    });
  });

  it("a place page for another name is no answer", () => {
    const got = placeOf("Northwind Plumbing", placeUrl, raw({ kind: "place", name: "Contoso" }), [
      body,
    ]);
    expect(got.placeId).toBeNull();
    expect(got.name).toBe("Contoso");
  });

  it("picks the first fitting result off a list, keeps the rest as candidates", () => {
    const href = (id: string) => `https://www.google.com/maps/place/X/data=!4m7!19s${id}?hl=en`;
    const list = raw({
      kind: "list",
      links: [
        { label: "Contoso Plumbing", href: href(OTHER) },
        { label: "Northwind Plumbing & Heating", href: href(PLACE) },
      ],
    });
    const got = placeOf("Northwind Plumbing, Springfield", "https://maps/x", list, []);
    expect(got).toMatchObject({
      placeId: PLACE,
      name: "Northwind Plumbing & Heating",
      via: "list",
    });
    expect(got.candidates).toHaveLength(2);
    const none = placeOf("Fabrikam, Springfield", "https://maps/x", list, []);
    expect(none).toMatchObject({ placeId: null, via: "none" });
  });

  it("is a desk leg behind web GET /place", () => {
    expect(BROWSER_FLOWS["web/google-place"]).toBeDefined();
    const r = web.routes.find((x) => x.path === "/place");
    expect(r?.browser).toMatchObject({ flow: "web/google-place" });
    expect(r?.request.safeParse({ q: "ab" }).success).toBe(false);
  });
});
