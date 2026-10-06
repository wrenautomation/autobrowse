import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { httpClient } from "../src/clients/http.js";
import type { ApiLeg } from "../src/sites/types.js";
import { youtube } from "../src/sites/youtube.js";

describe("youtube video upload", () => {
  it("streams a local file once, sized from disk", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "yt-")), "v.mp4");
    await writeFile(file, Buffer.alloc(1000, 7));
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.includes("/channels")) return Response.json({ items: [{ id: "UC1" }] });
      if (init.method === "POST")
        return new Response("{}", { headers: { location: "https://up.test/session" } });
      const sent = await new Response(init.body).arrayBuffer();
      return Response.json({ id: "vid", sent: sent.byteLength });
    };
    const leg: ApiLeg = {
      token: "t-upload",
      http: httpClient({ fetch }),
      env: (n) => (n === "YOUTUBE_CHANNEL_ID" ? "UC1" : undefined),
    };
    const r = youtube.routes.find((x) => x.path === "/upload/youtube/v3/videos");
    const api = r?.api as (i: unknown, leg: ApiLeg) => Promise<unknown>;
    const out = await api(r?.request.parse({ snippet: { title: "t" }, file }), leg);

    const [, start, put] = calls.map((c) => c.init as RequestInit & { duplex?: string });
    const header = (i: RequestInit | undefined, n: string) =>
      ((i?.headers ?? {}) as Record<string, string>)[n];
    expect(header(start, "X-Upload-Content-Length")).toBe("1000");
    expect(put?.body).toBeInstanceOf(ReadableStream);
    expect(put?.duplex).toBe("half");
    expect(header(put, "content-length")).toBe("1000");
    expect(out).toEqual({ id: "vid", sent: 1000 });
  });

  it("never retries a stream body", async () => {
    let n = 0;
    const http = httpClient({
      fetch: async () => {
        n += 1;
        return new Response("", { status: 503 });
      },
      sleep: async () => undefined,
    });
    const r = await http.json("https://up.test/session", {
      method: "PUT",
      raw: new Blob(["x"]).stream(),
    });
    expect([r.status, n]).toEqual([503, 1]);
  });
});
