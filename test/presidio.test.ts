import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  type Analyze,
  keepInbox,
  maskAll,
  presidioTrace,
  shareAdmin,
} from "../src/share/presidio.js";

/** Presidio stand-in: "Ada Byron" is a PERSON, "Paris" a LOCATION at a given score. */
const fake =
  (locScore = 0.9): Analyze =>
  async (text) => {
    const out: Awaited<ReturnType<Analyze>> = [];
    for (const [word, entity_type, score] of [
      ["Ada Byron", "PERSON", 0.85],
      ["Paris", "LOCATION", locScore],
      ["ada@x.test", "EMAIL_ADDRESS", 0.9],
    ] as const)
      for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1))
        out.push({ entity_type, start: i, end: i + word.length, score });
    return out;
  };

describe("maskAll", () => {
  it("masks spans in each string of a batch, by score", async () => {
    const m = await maskAll(["Hi Ada Byron", "no one", "Ada Byron in Paris"], fake());
    expect(m.get("Hi Ada Byron")).toBe("Hi <person>");
    expect(m.get("Ada Byron in Paris")).toBe("<person> in <location>");
    expect(m.has("no one")).toBe(false);
    const unsure = await maskAll(["Paris"], fake(0.5));
    expect(unsure.has("Paris")).toBe(false);
  });
});

describe("presidioTrace", () => {
  it("masks snapshot text and keeps the shape", async () => {
    const zip = zipSync({
      "trace.trace": strToU8(
        `${JSON.stringify({
          type: "frame-snapshot",
          snapshot: {
            frameUrl: "https://a.test/",
            html: ["BODY", {}, ["P", {}, "Dear Ada Byron"]],
          },
        })}\n`,
      ),
    });
    const out = strFromU8(unzipSync(await presidioTrace(zip, fake()))["trace.trace"] as Uint8Array);
    expect(out).toContain("Dear <person>");
    expect(out).not.toContain("Byron");
  });
});

describe("keepInbox", () => {
  it("moves inbox files to kept/; flow source kept intact, a flow with an email in it refused", async () => {
    const store = new Map<string, Uint8Array>();
    const enc = (s: string) => strToU8(s);
    const src = 'const parisSubmit = "Paris";';
    const pack = (code: string) =>
      enc(
        JSON.stringify({
          files: { "index.ts": code },
          proof: { steps: [{ detail: "Ada Byron" }] },
        }),
      );
    store.set("inbox/2026-10-24/id1/flows/a.flow.json", pack(src));
    store.set("inbox/2026-10-24/id1/flows/c.flow.json", pack('const to = "ada@x.test";'));
    store.set("inbox/2026-10-24/id1/traces/b.zip", enc("not a zip"));
    const f = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const path = u.pathname.replace("/admin/", "");
      if (path === "list") {
        const prefix = u.searchParams.get("prefix") ?? "";
        const keys = [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((key) => ({ key, size: 1 }));
        return Response.json({ keys, cursor: null });
      }
      const key = decodeURIComponent(path.slice("object/".length));
      if (init.method === "GET") return new Response(store.get(key));
      if (init.method === "DELETE") store.delete(key);
      if (init.method === "PUT") store.set(key, enc(String(init.body)));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const r = await keepInbox(shareAdmin("t", "https://s.test", f), fake());
    expect(r).toEqual({ kept: 1, bad: 1, held: 1, left: 0 });
    expect([...store.keys()].sort()).toEqual([
      "gate/held/2026-10-24/id1/traces/b.zip",
      "kept/flows/2026-10-24/id1/a.flow.json",
    ]);
    const kept = JSON.parse(
      strFromU8(store.get("kept/flows/2026-10-24/id1/a.flow.json") as Uint8Array),
    );
    expect(kept.files["index.ts"]).toBe(src);
    expect(kept.proof.steps[0].detail).toBe("<person>");
  });
});
