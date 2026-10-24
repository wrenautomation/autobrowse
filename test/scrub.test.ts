import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { redactPii } from "../src/recorder/redact.js";
import { type Known, ScrubLeak, scrubTrace } from "../src/share/scrub.js";

const NAME = "Quentin Marlowe";
const MAIL = "quentin.marlowe@example.org";
const TYPED = "Hunter Valley Road 42";
const known: Known[] = [
  { value: NAME, kind: "name" },
  { value: MAIL, kind: "email" },
  { value: TYPED, kind: "typed" },
];

const ndjson = (rows: object[]) => strToU8(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

/** A trace with each planted value in every place format 9 puts text. */
function fixture() {
  const trace = [
    {
      type: "context-options",
      version: 9,
      options: {
        userDataDir: "/Users/quentin/profile",
        args: ["--x"],
        viewport: { width: 1, height: 1 },
      },
    },
    {
      type: "before",
      callId: "c1",
      class: "Frame",
      method: "goto",
      params: {
        url: `https://a.test/u/${encodeURIComponent(NAME)}?email=${encodeURIComponent(MAIL)}#t`,
      },
    },
    {
      type: "before",
      callId: "c2",
      class: "Frame",
      method: "fill",
      params: { selector: "#addr", value: TYPED },
    },
    { type: "before", callId: "c3", class: "Page", method: "keyboardType", params: { text: "x9" } },
    {
      type: "before",
      callId: "c4",
      class: "Frame",
      method: "setInputFiles",
      params: { localPaths: ["/Users/quentin/resume.pdf"] },
    },
    { type: "after", callId: "c5", result: { value: TYPED } },
    { type: "after", callId: "c6", result: { value: `Hello ${NAME}` } },
    { type: "log", callId: "c2", message: `fill "${TYPED}"` },
    { type: "console", text: `user ${MAIL}`, args: [{ preview: MAIL }] },
    { type: "screencast-frame", file: "screencast/p-1.jpeg" },
    {
      type: "frame-snapshot",
      snapshot: {
        frameUrl: `https://a.test/me?n=${encodeURIComponent(NAME)}`,
        html: [
          "HTML",
          {},
          [
            "BODY",
            {},
            ["H1", {}, `Welcome back, ${NAME}`],
            ["A", { href: `mailto:${MAIL}` }, "mail"],
            ["INPUT", { value: "secret-ish", __playwright_value_: "other" }],
            ["TEXTAREA", {}, "my cover letter"],
            [
              "P",
              { title: NAME.toUpperCase() },
              "call +1 (416) 555-0199 or 10.1.2.3, id 123456789",
            ],
            ["SPAN", {}, JSON.stringify(TYPED).slice(1, -1)],
            [[3, 1]],
          ],
        ],
        resourceOverrides: [],
      },
    },
  ];
  const network = [
    {
      type: "resource-snapshot",
      snapshot: {
        request: {
          method: "POST",
          url: `https://a.test/api?q=${MAIL}`,
          headers: [{ name: "cookie", value: "s=1" }],
          postData: { text: NAME },
        },
        response: {
          status: 200,
          headers: [{ name: "set-cookie", value: "s=2" }],
          content: { mimeType: "application/json", _sha1: "body.json" },
        },
      },
    },
    {
      type: "resource-snapshot",
      snapshot: {
        request: { method: "GET", url: "https://a.test/s.css", headers: [] },
        response: { status: 200, headers: [], content: { mimeType: "text/css", _sha1: "s.css" } },
      },
    },
  ];
  return zipSync({
    "trace.trace": ndjson(trace),
    "trace.network": ndjson(network),
    "trace.stacks": strToU8(`/Users/quentin/app.ts`),
    "screencast/p-1.jpeg": new Uint8Array([1, 2, 3]),
    "resources/body.json": strToU8(JSON.stringify({ name: NAME })),
    "resources/s.css": strToU8(`body{color:red} /* ${MAIL} */`),
  });
}

describe("scrubTrace", () => {
  const out = unzipSync(scrubTrace(fixture(), known));
  const all = Object.values(out).map(strFromU8).join("\n");

  it("keeps the trace, the network and CSS; drops frames, stacks and bodies", () => {
    expect(Object.keys(out).sort()).toEqual(["resources/s.css", "trace.network", "trace.trace"]);
  });

  it("leaves no planted value in any form", () => {
    for (const v of [
      NAME,
      MAIL,
      TYPED,
      "quentin",
      "x9",
      "secret-ish",
      "other",
      "cover letter",
      "555-0199",
      "10.1.2.3",
      "123456789",
      "s=1",
      "s=2",
    ])
      expect(all.toLowerCase()).not.toContain(v.toLowerCase());
  });

  it("keeps the shape a viewer and a heal read", () => {
    const rows = strFromU8(out["trace.trace"] as Uint8Array)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows.map((r) => r.type)).not.toContain("screencast-frame");
    const fill = rows.find((r) => r.method === "fill");
    expect(fill.params).toEqual({ selector: "#addr", value: "<typed>" });
    const goto = rows.find((r) => r.method === "goto");
    expect(goto.params.url).toBe("https://a.test/u/<name>?email=<q>");
    const snap = rows.find((r) => r.type === "frame-snapshot").snapshot;
    expect(JSON.stringify(snap.html)).toContain("Welcome back, <name>");
    expect(JSON.stringify(snap.html)).toContain("[[3,1]]");
    expect(rows.find((r) => r.type === "context-options").options).toEqual({
      viewport: { width: 1, height: 1 },
    });
    const net = strFromU8(out["trace.network"] as Uint8Array)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(net[0].snapshot.request).toMatchObject({
      method: "POST",
      url: "https://a.test/api?q=<q>",
      headers: [],
    });
    expect(net[1].snapshot.response.content._sha1).toBe("s.css");
  });

  it("throws when a known value survives", () => {
    // A resource id is kept as is, so a known value there is a leak the check must catch.
    const zip = zipSync({
      "trace.network": ndjson([
        {
          type: "resource-snapshot",
          snapshot: {
            request: { url: "https://a.test/c.css" },
            response: { content: { mimeType: "text/css", _sha1: "marlowe1" } },
          },
        },
      ]),
      "resources/marlowe1": strToU8("p{}"),
    });
    expect(() => scrubTrace(zip, [{ value: "Marlowe1", kind: "name" }])).toThrow(ScrubLeak);
    expect(() => scrubTrace(zip, [{ value: "Quentin", kind: "name" }])).not.toThrow();
  });
});

describe("redactPii", () => {
  it("masks a home folder and phones as people write them, not SVG numbers or short values", () => {
    expect(redactPii("at f (/Users/quentin/app.js:1) C:\\Users\\q\\x")).toBe(
      "at f (/Users/<user>/app.js:1) C:\\Users\\<user>\\x",
    );
    expect(redactPii("416.555.0199 or +44 20 7946 0958")).toBe("<phone> or <phone>");
    expect(redactPii("M4 6.505l4 10-10 2.63.827")).toBe("M4 6.505l4 10-10 2.63.827");
  });

  it("skips short values: a year is not a person", () => {
    const zip = zipSync({ "trace.trace": ndjson([{ type: "log", message: "2026 Java" }]) });
    const rows = strFromU8(
      unzipSync(
        scrubTrace(zip, [
          { value: "2026", kind: "typed" },
          { value: "Java", kind: "typed" },
        ]),
      )["trace.trace"] as Uint8Array,
    );
    expect(rows).toContain("2026 Java");
  });

  it("masks addresses, phones, IPs and long ids, not short numbers", () => {
    expect(redactPii("a@b.co +1 416 555 0199 192.168.0.1 order 98765432 page 12")).toBe(
      "<email> <phone> <ip> order <id> page 12",
    );
  });
});
