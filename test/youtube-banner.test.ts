import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { httpClient } from "../src/clients/http.js";
import type { ApiLeg } from "../src/sites/types.js";
import { youtube } from "../src/sites/youtube.js";

describe("youtube channel banner", () => {
  it("uploads the image, then sets it keeping the rest of brandingSettings", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "yt-")), "b.png");
    await writeFile(file, Buffer.alloc(10, 1));
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.includes("channelBanners/insert")) return Response.json({ url: "https://yt3/b" });
      if (init.method === "PUT") return Response.json({ id: "UC1" });
      return Response.json({
        items: [
          {
            id: "UC1",
            brandingSettings: { channel: { title: "Wren" }, image: { old: true } },
          },
        ],
      });
    };
    const leg: ApiLeg = {
      token: "t",
      http: httpClient({ fetch }),
      env: (n) => (n === "YOUTUBE_CHANNEL_ID" ? "UC1" : undefined),
    };
    const r = youtube.routes.find((x) => x.path === "/youtube/v3/channelBanner");
    const api = r?.api as (i: unknown, leg: ApiLeg) => Promise<unknown>;
    const out = await api(r?.request.parse({ file }), leg);

    expect(out).toEqual({ channel: "UC1", bannerUrl: "https://yt3/b" });
    const put = calls.find((c) => c.init.method === "PUT");
    expect(put?.url).toContain("part=brandingSettings");
    expect(JSON.parse(String(put?.init.body))).toEqual({
      id: "UC1",
      brandingSettings: {
        channel: { title: "Wren" },
        image: { old: true, bannerExternalUrl: "https://yt3/b" },
      },
    });
  });
});
