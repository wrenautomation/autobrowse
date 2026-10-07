import { describe, expect, it } from "vitest";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { memoryCaps } from "../src/sites/caps.js";
import { siteFacade, youtube } from "../src/sites/index.js";
import { csvRows, REACH_REPORT, youtubeOAuth } from "../src/sites/youtube.js";
import { fakeBrowser } from "./fakes.js";

const KEYS: Record<string, string> = {
  GOOGLE_OAUTH_CLIENT_ID: "cid",
  GOOGLE_OAUTH_CLIENT_SECRET: "cs",
  YOUTUBE_REFRESH_TOKEN: "rt",
};

type Answer = { status?: number; body?: unknown; text?: string };
type Seen = { method: string; url: URL; auth: string | null; body: string };

/** A facade over a fake Google: `answer` sees every call past the token mint. */
function facade(answer: (req: Seen) => Answer) {
  const token = `at-${Math.random().toString(36).slice(2)}`;
  const seen: Seen[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.host === "oauth2.googleapis.com")
      return Response.json({ access_token: token, expires_in: 3600 });
    const req: Seen = {
      method: init?.method ?? "GET",
      url: u,
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : "",
    };
    seen.push(req);
    const a = answer(req);
    return a.text !== undefined
      ? new Response(a.text, { status: a.status ?? 200, headers: { "content-type": "text/csv" } })
      : Response.json(a.body ?? {}, { status: a.status ?? 200 });
  };
  const sites = siteFacade([youtube], {
    http: httpClient({ fetch, attempts: 1 }),
    env: (n) => KEYS[n],
    sink: memorySink(),
    runner: fakeBrowser([]),
    flow: () => null,
    caps: memoryCaps(),
  });
  return { sites, seen, token };
}

describe("youtube analytics and reporting", () => {
  it("consent asks for yt-analytics.readonly beside the Data API scopes", () => {
    expect(youtubeOAuth.scopes).toContain("https://www.googleapis.com/auth/yt-analytics.readonly");
    expect(youtubeOAuth.scopes).toContain("https://www.googleapis.com/auth/youtube.readonly");
  });

  it("GET /v2/reports queries YouTube Analytics with the bearer and counts against its bucket", async () => {
    const report = {
      columnHeaders: [{ name: "views" }, { name: "averageViewPercentage" }],
      rows: [[120, 41.5]],
    };
    const { sites, seen, token } = facade(() => ({ body: report }));
    const got = await sites.call("youtube", "GET", "/v2/reports", {
      startDate: "2026-10-01",
      endDate: "2026-10-07",
      metrics: "views,averageViewPercentage",
      filters: "video==v1",
    });
    expect(got).toEqual(report);
    const [call] = seen;
    expect(call?.url.origin).toBe("https://youtubeanalytics.googleapis.com");
    expect(call?.url.pathname).toBe("/v2/reports");
    expect(call?.url.searchParams.get("ids")).toBe("channel==MINE");
    expect(call?.url.searchParams.get("filters")).toBe("video==v1");
    expect(call?.auth).toBe(`Bearer ${token}`);
    const used = sites.caps(undefined, "youtube").used;
    expect(Object.entries(used).find(([k]) => k.endsWith("|analytics"))?.[1]).toBe(1);
  });

  it("a query without dates is the caller's mistake, and nothing is sent", async () => {
    const { sites, seen } = facade(() => ({ body: {} }));
    await expect(
      sites.call("youtube", "GET", "/v2/reports", { metrics: "views" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(0);
  });

  it("a refusal keeps Google's words and its status, never the token or the query", async () => {
    const { sites, token } = facade(() => ({
      status: 403,
      body: {
        error: {
          code: 403,
          message:
            "Request had insufficient authentication scopes. See https://developers.google.com/x?key=secret",
        },
      },
    }));
    const err = (await sites
      .call("youtube", "GET", "/v2/reports", {
        startDate: "2026-10-01",
        endDate: "2026-10-07",
        metrics: "views",
      })
      .catch((e: unknown) => e)) as Error & { status: number };
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/insufficient authentication scopes/);
    expect(err.message).not.toContain(token);
    expect(err.message).not.toContain("key=secret");
    expect(err.message).not.toContain("startDate");
  });

  it("lists and starts Reporting API jobs", async () => {
    const { sites, seen } = facade((r) =>
      r.method === "POST"
        ? { body: { id: "job1", reportTypeId: REACH_REPORT, name: "wren reach" } }
        : { body: { jobs: [] } },
    );
    expect(await sites.call("youtube", "GET", "/v1/jobs", {})).toEqual({ jobs: [] });
    const job = await sites.call("youtube", "POST", "/v1/jobs", {
      reportTypeId: REACH_REPORT,
      name: "wren reach",
    });
    expect(job).toMatchObject({ id: "job1" });
    expect(seen.map((s) => `${s.method} ${s.url.origin}${s.url.pathname}`)).toEqual([
      "GET https://youtubereporting.googleapis.com/v1/jobs",
      "POST https://youtubereporting.googleapis.com/v1/jobs",
    ]);
    expect(JSON.parse(seen[1]?.body ?? "{}")).toEqual({
      reportTypeId: REACH_REPORT,
      name: "wren reach",
    });
  });

  it("lists a job's reports created after a time", async () => {
    const { sites, seen } = facade(() => ({ body: { reports: [{ id: "r1" }] } }));
    await sites.call("youtube", "GET", "/v1/jobs/job1/reports", {
      createdAfter: "2026-10-05T00:00:00Z",
    });
    expect(seen[0]?.url.pathname).toBe("/v1/jobs/job1/reports");
    expect(seen[0]?.url.searchParams.get("createdAfter")).toBe("2026-10-05T00:00:00Z");
  });

  it("downloads a report and answers its CSV as rows", async () => {
    const download = `${"https://youtubereporting.googleapis.com"}/v1/media/CHANNEL/c1/jobs/job1/reports/r1?alt=media`;
    const csv =
      "date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr\r\n" +
      "20261005,UCsynthetic,vid1,1200,4.5\r\n" +
      '20261005,UCsynthetic,"vid,2",30,0\r\n';
    const { sites, seen, token } = facade((r) =>
      r.url.pathname.startsWith("/v1/media/")
        ? { text: csv }
        : {
            body: {
              id: "r1",
              startTime: "2026-10-05T07:00:00Z",
              endTime: "2026-10-06T07:00:00Z",
              createTime: "2026-10-07T01:00:00Z",
              downloadUrl: download,
            },
          },
    );
    const got = await sites.call("youtube", "GET", "/v1/jobs/job1/reports/r1/rows", {});
    expect(got).toEqual({
      id: "r1",
      startTime: "2026-10-05T07:00:00Z",
      endTime: "2026-10-06T07:00:00Z",
      createTime: "2026-10-07T01:00:00Z",
      rows: [
        {
          date: "20261005",
          channel_id: "UCsynthetic",
          video_id: "vid1",
          video_thumbnail_impressions: "1200",
          video_thumbnail_impressions_ctr: "4.5",
        },
        {
          date: "20261005",
          channel_id: "UCsynthetic",
          video_id: "vid,2",
          video_thumbnail_impressions: "30",
          video_thumbnail_impressions_ctr: "0",
        },
      ],
    });
    expect(seen[1]?.auth).toBe(`Bearer ${token}`);
  });

  it("never sends the bearer to a download URL off the Reporting host", async () => {
    const { sites, seen } = facade(() => ({
      body: { id: "r1", downloadUrl: "https://elsewhere.test/r1.csv" },
    }));
    await expect(
      sites.call("youtube", "GET", "/v1/jobs/job1/reports/r1/rows", {}),
    ).rejects.toMatchObject({ status: 502 });
    expect(seen.map((s) => s.url.host)).toEqual(["youtubereporting.googleapis.com"]);
  });
});

describe("csvRows", () => {
  it("reads quotes, doubled quotes, LF and a missing last newline", () => {
    expect(csvRows('a,b\n"x, y","say ""hi"""\n1,2')).toEqual([
      { a: "x, y", b: 'say "hi"' },
      { a: "1", b: "2" },
    ]);
    expect(csvRows("")).toEqual([]);
    expect(csvRows("a,b\r\n")).toEqual([]);
  });
});
