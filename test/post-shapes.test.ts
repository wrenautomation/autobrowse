import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { httpClient } from "../src/clients/http.js";
import { instagram } from "../src/sites/instagram.js";
import { meta } from "../src/sites/meta.js";
import { tiktok } from "../src/sites/tiktok.js";
import type { ApiLeg, SiteApi } from "../src/sites/types.js";
import { x } from "../src/sites/x.js";
import { youtube } from "../src/sites/youtube.js";

type Call = { url: string; init: RequestInit };

/** A leg whose every call is recorded; the answer comes from `answer`. */
function recorder(answer: (url: string, init: RequestInit) => Response = () => Response.json({})) {
  const calls: Call[] = [];
  const leg: ApiLeg = {
    token: `t-${Math.random()}`,
    http: httpClient({
      fetch: async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url.includes("/youtube/v3/channels?part=id"))
          return Response.json({ items: [{ id: "UC1" }] });
        return answer(url, init);
      },
      sleep: async () => undefined,
    }),
    env: (n) => (n === "YOUTUBE_CHANNEL_ID" ? "UC1" : undefined),
  };
  return { calls, leg };
}

function routeOf(site: SiteApi, method: string, path: string) {
  const r = site.routes.find((x) => x.method === method && x.path === path);
  if (!r?.api) throw new Error(`no ${method} ${path}`);
  const api = r.api as (i: unknown, leg: ApiLeg) => Promise<unknown>;
  return { r, call: async (input: unknown, leg: ApiLeg) => api(r.request.parse(input), leg) };
}

const json = (c: Call | undefined) => JSON.parse(String(c?.init.body));
const header = (c: Call | undefined, n: string) =>
  ((c?.init.headers ?? {}) as Record<string, string>)[n];

describe("youtube upload shape", () => {
  const upload = routeOf(youtube, "POST", "/upload/youtube/v3/videos");

  async function start(input: Record<string, unknown>) {
    const file = join(await mkdtemp(join(tmpdir(), "yt-")), "v.mp4");
    await writeFile(file, Buffer.alloc(10, 1));
    const { calls, leg } = recorder((_url, init) =>
      init.method === "POST"
        ? new Response("{}", { headers: { location: "https://up.test/s" } })
        : Response.json({ id: "vid" }),
    );
    await upload.call({ snippet: { title: "t" }, file, ...input }, leg);
    return calls.find((c) => c.url.includes("/upload/youtube/v3/videos?"));
  }

  it("sends notifySubscribers as a query param, never in the body", async () => {
    const c = await start({
      notifySubscribers: false,
      snippet: { title: "t", defaultAudioLanguage: "en" },
      status: { privacyStatus: "private", containsSyntheticMedia: true },
    });
    expect(new URL(c?.url ?? "").searchParams.get("notifySubscribers")).toBe("false");
    const body = json(c);
    expect(body).not.toHaveProperty("notifySubscribers");
    expect(body.snippet.defaultAudioLanguage).toBe("en");
    expect(body.status.containsSyntheticMedia).toBe(true);
  });

  it("leaves the param off when unset", async () => {
    const c = await start({});
    expect(new URL(c?.url ?? "").searchParams.has("notifySubscribers")).toBe(false);
    expect(json(c).status).not.toHaveProperty("containsSyntheticMedia");
  });
});

describe("youtube captions", () => {
  const captions = routeOf(youtube, "POST", "/upload/youtube/v3/captions");

  it("uploads multipart: the snippet as JSON, then the file's bytes; answers the caption", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "yt-")), "c.srt");
    await writeFile(file, "1\n00:00:00,000 --> 00:00:01,000\nHi\n");
    const { calls, leg } = recorder(() => Response.json({ id: "cap1", kind: "youtube#caption" }));
    const out = await captions.call({ videoId: "vid", language: "pt-BR", file }, leg);
    expect(out).toEqual({ id: "cap1", kind: "youtube#caption" });

    const c = calls.at(-1);
    const u = new URL(c?.url ?? "");
    expect(u.pathname).toBe("/upload/youtube/v3/captions");
    expect(u.searchParams.get("part")).toBe("snippet");
    expect(u.searchParams.get("uploadType")).toBe("multipart");
    const type = header(c, "content-type");
    expect(type).toMatch(/^multipart\/related; boundary=/);
    const sent = new TextDecoder().decode(c?.init.body as Uint8Array);
    const boundary = type?.split("boundary=")[1];
    const parts = sent.split(`--${boundary}`);
    expect(parts).toHaveLength(4);
    const [, metaPart, mediaPart, end] = parts;
    expect(metaPart).toContain("Content-Type: application/json");
    expect(JSON.parse(metaPart?.split("\r\n\r\n")[1] ?? "")).toEqual({
      snippet: { videoId: "vid", language: "pt-BR", name: "", isDraft: false },
    });
    expect(mediaPart).toContain("Content-Type: application/octet-stream");
    expect(mediaPart).toContain("00:00:00,000 --> 00:00:01,000\nHi\n");
    expect(end).toBe("--\r\n");
  });

  it("checks the channel first and refuses a bad input before any call", async () => {
    const { calls, leg } = recorder();
    await expect(captions.call({ videoId: "vid", file: "x.srt" }, leg)).rejects.toThrow();
    expect(calls).toHaveLength(0);
    const wrong = recorder();
    wrong.leg.env = () => "UC_OTHER";
    await expect(
      captions.call({ videoId: "vid", language: "en", file: "x.srt" }, wrong.leg),
    ).rejects.toThrow(/not YOUTUBE_CHANNEL_ID/);
    expect(wrong.calls.every((c) => c.url.includes("/channels"))).toBe(true);
  });
});

describe("youtube playlistItems", () => {
  it("adds a video to a playlist and answers the item", async () => {
    const add = routeOf(youtube, "POST", "/youtube/v3/playlistItems");
    const { calls, leg } = recorder(() => Response.json({ id: "pi1" }));
    expect(await add.call({ playlistId: "PL1", videoId: "vid" }, leg)).toEqual({ id: "pi1" });
    const c = calls.at(-1);
    expect(c?.url).toBe("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet");
    expect(c?.init.method).toBe("POST");
    expect(json(c)).toEqual({
      snippet: { playlistId: "PL1", resourceId: { kind: "youtube#video", videoId: "vid" } },
    });
  });
});

describe("tiktok publish init shape", () => {
  it("passes the AI and brand flags through post_info, keeping the old ones", async () => {
    const init = routeOf(tiktok, "POST", "/v2/post/publish/video/init/");
    const { calls, leg } = recorder(() => Response.json({ data: { publish_id: "p1" } }));
    await init.call(
      {
        post_info: {
          title: "t",
          disable_duet: true,
          video_cover_timestamp_ms: 1000,
          is_aigc: true,
          brand_content_toggle: false,
          brand_organic_toggle: true,
        },
        source_info: { source: "PULL_FROM_URL", video_url: "https://cdn.test/v.mp4" },
      },
      leg,
    );
    expect(json(calls.at(-1)).post_info).toMatchObject({
      disable_duet: true,
      video_cover_timestamp_ms: 1000,
      is_aigc: true,
      brand_content_toggle: false,
      brand_organic_toggle: true,
    });
  });
});

describe("instagram container shape", () => {
  for (const site of [meta, instagram]) {
    const container = routeOf(site, "POST", "/{igUserId}/media");

    it(`${site.site}: sends thumb_offset, collaborators and audio_name`, async () => {
      const { calls, leg } = recorder(() => Response.json({ id: "c1" }));
      await container.call(
        {
          igUserId: "17",
          video_url: "https://cdn.test/v.mp4",
          media_type: "REELS",
          thumb_offset: 2500,
          collaborators: ["a.b", "c_d"],
          audio_name: "Original audio",
        },
        leg,
      );
      expect(json(calls.at(-1))).toMatchObject({
        thumb_offset: 2500,
        collaborators: ["a.b", "c_d"],
        audio_name: "Original audio",
      });
    });

    it(`${site.site}: refuses a negative offset, four collaborators, or a bad username`, () => {
      const bad = [
        { thumb_offset: -1 },
        { thumb_offset: 1.5 },
        { collaborators: ["a", "b", "c", "d"] },
        { collaborators: [] },
        { collaborators: ["no spaces"] },
      ];
      for (const b of bad)
        expect(container.r.request.safeParse({ igUserId: "17", ...b }).success).toBe(false);
    });
  }
});

describe("x post shape", () => {
  const post = routeOf(x, "POST", "/2/tweets");

  it("sends reply_settings", async () => {
    const { calls, leg } = recorder(() => Response.json({ data: { id: "1" } }));
    await post.call({ text: "hi", reply_settings: "mentionedUsers" }, leg);
    expect(json(calls.at(-1))).toEqual({ text: "hi", reply_settings: "mentionedUsers" });
  });

  it("takes only the four values X knows", () => {
    for (const v of ["following", "mentionedUsers", "subscribers", "verified"])
      expect(post.r.request.safeParse({ text: "hi", reply_settings: v }).success).toBe(true);
    expect(post.r.request.safeParse({ text: "hi", reply_settings: "everyone" }).success).toBe(
      false,
    );
  });
});
