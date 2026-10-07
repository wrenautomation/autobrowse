import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withCall } from "../src/browser/attempt.js";
import { httpClient } from "../src/clients/http.js";
import type { ApiLeg } from "../src/sites/types.js";
import { fileUploadSessions } from "../src/sites/uploads.js";
import { youtube } from "../src/sites/youtube.js";

const route = youtube.routes.find((x) => x.path === "/upload/youtube/v3/videos");
const upload = route?.api as (i: unknown, leg: ApiLeg) => Promise<unknown>;
const header = (i: RequestInit | undefined, n: string) =>
  ((i?.headers ?? {}) as Record<string, string>)[n];

async function setup(bytes: number) {
  const dir = await mkdtemp(join(tmpdir(), "yt-"));
  const file = join(dir, "v.mp4");
  await writeFile(file, Buffer.alloc(bytes, 7));
  return { file, uploads: fileUploadSessions(join(dir, "uploads")) };
}

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

  it("a rerun call asks its session and sends only the rest", async () => {
    const { file, uploads } = await setup(1000);
    let fail = true;
    const puts: RequestInit[] = [];
    let posts = 0;
    const fetch = async (url: string, init: RequestInit = {}) => {
      if (url.includes("/channels")) return Response.json({ items: [{ id: "UC1" }] });
      if (init.method === "POST") {
        posts += 1;
        return new Response("{}", { headers: { location: "https://up.test/s1" } });
      }
      puts.push(init);
      if (header(init, "content-range") === "bytes */1000")
        return new Response(null, { status: 308, headers: { range: "bytes=0-399" } });
      if (fail) {
        fail = false;
        throw new TypeError("terminated");
      }
      const sent = await new Response(init.body).arrayBuffer();
      return Response.json({ id: "vid", sent: sent.byteLength });
    };
    const leg: ApiLeg = {
      token: "t-resume",
      http: httpClient({ fetch, attempts: 1 }),
      env: (n) => (n === "YOUTUBE_CHANNEL_ID" ? "UC1" : undefined),
      uploads,
    };
    const input = route?.request.parse({ snippet: { title: "t" }, file });
    const out = await withCall("inv1 step", () => upload(input, leg));
    expect(out).toEqual({ id: "vid", sent: 600 });
    expect(header(puts.at(-1), "content-range")).toBe("bytes 400-999/1000");
    expect(header(puts.at(-1), "content-length")).toBe("600");
    // Restate reruns the same call: the session answers it is whole, and no second upload starts.
    const done = async (url: string, init: RequestInit = {}) => {
      if (url.includes("/channels")) return Response.json({ items: [{ id: "UC1" }] });
      if (init.method === "POST") throw new Error("a second session was started");
      return Response.json({ id: "vid" }, { status: 200 });
    };
    const again = await withCall("inv1 step", () =>
      upload(input, { ...leg, http: httpClient({ fetch: done }) }),
    );
    expect([again, posts]).toEqual([{ id: "vid" }, 1]);
  });

  it("a rerun while the bytes still send joins them", async () => {
    const { file, uploads } = await setup(10);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let puts = 0;
    const fetch = async (url: string, init: RequestInit = {}) => {
      if (url.includes("/channels")) return Response.json({ items: [{ id: "UC1" }] });
      if (init.method === "POST")
        return new Response("{}", { headers: { location: "https://up.test/s2" } });
      puts += 1;
      await gate;
      return Response.json({ id: "vid2" });
    };
    const leg: ApiLeg = {
      token: "t-join",
      http: httpClient({ fetch }),
      env: (n) => (n === "YOUTUBE_CHANNEL_ID" ? "UC1" : undefined),
      uploads,
    };
    const input = route?.request.parse({ snippet: { title: "t" }, file });
    const first = withCall("inv2 step", () => upload(input, leg));
    await new Promise((r) => setTimeout(r, 20));
    const second = withCall("inv2 step", () => upload(input, leg));
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect(await Promise.all([first, second])).toEqual([{ id: "vid2" }, { id: "vid2" }]);
    expect(puts).toBe(1);
  });

  it("changes and deletes a video on the configured channel only", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.includes("/channels")) return Response.json({ items: [{ id: "UC1" }] });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ id: "v1" });
    };
    const leg: ApiLeg = {
      token: "t-edit",
      http: httpClient({ fetch }),
      env: (n) => (n === "YOUTUBE_CHANNEL_ID" ? "UC1" : undefined),
    };
    const of = (method: string) => {
      const r = youtube.routes.find((x) => x.method === method && x.path === "/youtube/v3/videos");
      if (!r?.api) throw new Error(`no ${method} /youtube/v3/videos`);
      return { api: r.api as (i: unknown, l: ApiLeg) => Promise<unknown>, request: r.request };
    };
    const put = of("PUT");
    const del = of("DELETE");
    const status = { privacyStatus: "private" };
    await put.api(put.request.parse({ id: "v1", status }), leg);
    expect(calls.at(-1)?.url).toBe("https://www.googleapis.com/youtube/v3/videos?part=status");
    expect(() => put.request.parse({ id: "v1" })).toThrow();
    const out = await del.api(del.request.parse({ id: "v1" }), leg);
    expect([out, calls.at(-1)?.init.method]).toEqual([{ deleted: "v1" }, "DELETE"]);
  });
});
