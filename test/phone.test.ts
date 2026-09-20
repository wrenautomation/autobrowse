import { describe, expect, it } from "vitest";
import { phoneChannel } from "../src/channels/phone.js";
import { phoneNotifier, phoneReader, textFromAttributedBody } from "../src/devices/phone.js";

const APPLE = 978_307_200;
const ns = (unixS: number) => (unixS - APPLE) * 1e9;

/** A typedstream fragment: ...NSString + 5 header bytes + length + text. */
function body(text: string): string {
  const t = Buffer.from(text, "utf8");
  const len =
    t.length < 0x81 ? Buffer.from([t.length]) : Buffer.from([0x81, t.length & 0xff, t.length >> 8]);
  return Buffer.concat([
    Buffer.from("junkNSString"),
    Buffer.alloc(5, 1),
    len,
    t,
    Buffer.from("tail"),
  ]).toString("hex");
}

describe("phone", () => {
  it("reads the text out of attributedBody, short and long", () => {
    expect(textFromAttributedBody(body("G-123456 is your Google code"))).toBe(
      "G-123456 is your Google code",
    );
    const long = "x".repeat(300);
    expect(textFromAttributedBody(body(long))).toBe(long);
    expect(textFromAttributedBody("00ff")).toBeNull();
  });

  it("returns incoming messages newer than since, text from either column, dates converted", async () => {
    const queries: string[] = [];
    const now = 1_789_900_000;
    const reader = phoneReader({
      number: "+15555550100",
      sql(q) {
        queries.push(q);
        return JSON.stringify([
          { sender: "22000", text: "", body: body("Your code is 654321"), date: ns(now) },
          { sender: "+15555550199", text: "hi", body: "", date: ns(now - 10) },
          { sender: null, text: "", body: "", date: ns(now - 20) },
        ]);
      },
    });
    const got = await reader.recent("+15555550100", new Date((now - 60) * 1000));
    expect(queries[0]).toMatch(/is_from_me = 0/);
    expect(queries[0]).toContain(`m.date > ${ns(now - 60)}`);
    expect(got.map((m) => [m.from, m.text])).toEqual([
      ["22000", "Your code is 654321"],
      ["+15555550199", "hi"],
    ]);
    expect(got[0]?.at.getTime()).toBe(now * 1000);
  });

  it("notifies and delivers run events as one iMessage each", async () => {
    const sent: Array<[string, string]> = [];
    const opts = {
      number: "+15555550100",
      send: (to: string, text: string) => sent.push([to, text]),
    };
    await phoneNotifier(opts)("tap Yes");
    await phoneChannel(opts).deliver({
      type: "finished",
      run: { workflow: "domain", key: "x.com" },
      at: new Date().toISOString(),
      status: "done",
      summary: "all steps done",
    });
    expect(sent[0]).toEqual(["+15555550100", "tap Yes"]);
    expect(sent.length).toBe(2);
    expect(sent[1]?.[1]).toMatch(/domain/);
  });
});
