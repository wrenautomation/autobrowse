/** The bounded and cached paths: what they keep, what they drop, what they never fetch twice. */
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCredentials } from "credvault";
import { describe, expect, it } from "vitest";
import { gmailClient } from "../src/clients/gmail.js";
import { httpClient } from "../src/clients/http.js";
import type { RunEvent } from "../src/engine/events.js";
import {
  cursorOf,
  orderedRows,
  pageOf,
  pageOfOrdered,
  type RunRow,
  trimRows,
} from "../src/engine/rows.js";
import { eventBus } from "../src/ui/bus.js";

const row = (key: string, status: RunRow["status"], updatedAt: string): RunRow => ({
  workflow: "w",
  key,
  startedAt: updatedAt,
  updatedAt,
  status,
  gate: null,
  lastStep: null,
});

describe("bounded state", () => {
  it("trimRows keeps every live run and the newest settled ones up to the cap", () => {
    const rows = [
      row("e", "done", "2026-09-05"),
      row("d", "waiting", "2026-09-04"),
      row("c", "failed", "2026-09-03"),
      row("b", "running", "2026-09-02"),
      row("a", "done", "2026-09-01"),
    ];
    expect(trimRows(rows, 3).map((r) => r.key)).toEqual(["e", "d", "b"]);
    expect(trimRows(rows, 2).map((r) => r.key)).toEqual(["d", "b"]);
    expect(trimRows(rows, 5)).toBe(rows);
  });

  it("an ordered list pages by bisecting to the cursor; the old map shape still reads", () => {
    const rows = ["e", "d", "c", "b", "a"].map((k, i) => row(k, "done", `2026-09-0${5 - i}`));
    expect(pageOfOrdered(rows, { limit: 2 }).map((r) => r.key)).toEqual(["e", "d"]);
    expect(
      pageOfOrdered(rows, { limit: 2, before: cursorOf(rows[1] as RunRow) }).map((r) => r.key),
    ).toEqual(["c", "b"]);
    expect(pageOfOrdered(rows, { before: "2026-09-02" }).map((r) => r.key)).toEqual(["a"]);
    expect(pageOfOrdered(rows, { before: "2026-09-00" })).toEqual([]);
    expect(pageOfOrdered(rows, {})).toEqual(pageOf([...rows].reverse(), {}));
    const asMap = Object.fromEntries(rows.map((r) => [`w/${r.key}`, r]));
    expect(orderedRows(asMap).map((r) => r.key)).toEqual(["e", "d", "c", "b", "a"]);
    expect(orderedRows(null)).toEqual([]);
  });

  it("the event bus ring drops the oldest at capacity and bisects `recent(after)`", async () => {
    const bus = eventBus(3);
    const ev = (n: number): RunEvent =>
      ({ type: "step", at: `t${n}`, run: { workflow: "w", key: "k" }, step: `s${n}` }) as RunEvent;
    for (let n = 1; n <= 5; n++) await bus.deliver(ev(n));
    expect(bus.recent().map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(bus.recent(3).map((e) => e.seq)).toEqual([4, 5]);
    expect(bus.recent(4).map((e) => e.seq)).toEqual([5]);
    expect(bus.recent(5)).toEqual([]);
    expect(bus.recent(1).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(eventBus(3).recent()).toEqual([]);
  });
});

describe("cached reads", () => {
  it("the credential file is parsed once per version: a rewrite by another process is seen, a put invalidates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-perf-"));
    const file = join(dir, "c.json");
    const store = fileCredentials(file);
    expect(await store.get("a")).toBeNull();
    await store.put("a", { username: "u", password: "p" });
    const first = await store.get("a");
    expect(await store.get("a")).toBe(first); // same parse
    // Another process wrote the file: a new mtime and size, so it is read again.
    writeFileSync(file, JSON.stringify({ sites: { a: { username: "u2", password: "p" } } }));
    utimesSync(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    expect((await store.get("a"))?.username).toBe("u2");
  });

  it("gmail recent fetches each body once across polls, all ids at once", async () => {
    const urls: string[] = [];
    const fetch = async (url: string): Promise<Response> => {
      urls.push(url);
      const body = url.includes("/messages?")
        ? { messages: [{ id: "m1" }, { id: "m2" }] }
        : {
            internalDate: url.includes("m1") ? "2000" : "1000",
            payload: {
              headers: [{ name: "From", value: "x@y.z" }],
              mimeType: "text/plain",
              body: { data: Buffer.from("code 123456").toString("base64url") },
            },
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = gmailClient({
      tokenFor: () => async () => "tok",
      scopes: { settings: "s", send: "s", read: "r" },
      http: httpClient({ fetch }),
    });
    const first = await client.recent("me@x.dev", new Date(0));
    expect(first.map((m) => m.text.trim())).toEqual(["code 123456", "code 123456"]);
    expect(urls.filter((u) => u.includes("format=full"))).toHaveLength(2);
    const second = await client.recent("me@x.dev", new Date(0));
    expect(second).toHaveLength(2);
    expect(urls.filter((u) => u.includes("format=full"))).toHaveLength(2);
    // Another inbox is another mailbox: its bodies are its own.
    await client.recent("other@x.dev", new Date(0));
    expect(urls.filter((u) => u.includes("format=full"))).toHaveLength(4);
  });
});
