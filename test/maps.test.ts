import { describe, expect, it } from "vitest";
import { csvRows, mapsScrape } from "../src/reach/maps.js";

describe("maps", () => {
  it("posts the job, waits it out, downloads the CSV", async () => {
    const statuses = ["pending", "working", "working", "ok"];
    const calls: Array<{ url: string; body?: unknown }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith("/api/v1/jobs")) return Response.json({ id: "j1" }, { status: 201 });
      if (url.endsWith("/download")) return new Response('title,emails\n"A, Inc",a@a.test\n');
      return Response.json({ Status: statuses.shift() });
    }) as typeof fetch;
    const seen: string[] = [];
    const csv = await mapsScrape(
      { keywords: ["ria in austin tx"], depth: 1, email: true, maxMinutes: 5 },
      { fetch: f, sleep: async () => undefined, onStatus: (s) => seen.push(s), base: "http://m" },
    );
    expect(csvRows(csv)).toBe(1);
    expect(seen).toEqual(["pending", "working", "ok"]);
    expect(calls[0]?.body).toMatchObject({
      keywords: ["ria in austin tx"],
      max_time: 300,
      email: true,
    });
    expect(calls.at(-1)?.url).toBe("http://m/api/v1/jobs/j1/download");
  });

  it("a failed job says where to look", async () => {
    const f = (async (url: string) =>
      url.endsWith("/jobs")
        ? Response.json({ id: "j2" })
        : Response.json({ Status: "failed" })) as typeof fetch;
    await expect(
      mapsScrape(
        { keywords: ["x"], depth: 1, email: false, maxMinutes: 1 },
        { fetch: f, base: "http://m" },
      ),
    ).rejects.toThrow(/docker logs autobrowse-maps/);
  });

  it("counts rows, not newlines inside a quoted cell", () => {
    expect(csvRows('a,b\n"x\ny",1\nz,2\n')).toBe(2);
  });
});
