/**
 * YouTube under the Data API v3's shape: resumable upload at
 * `/upload/youtube/v3/videos`, thumbnails, any `GET /youtube/v3/{resource}`
 * with its own query, comments. The API covers the channel; only community
 * posts and Studio-only settings need the browser, and those routes say
 * they have no official path.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { HttpError } from "../clients/http.js";
import { type ApiLeg, type OAuthSpec, route, type SiteApi } from "./types.js";

export const YOUTUBE_ORIGIN = "https://www.googleapis.com";

const bearer = (leg: ApiLeg) => ({ authorization: `Bearer ${leg.token}` });

async function must<T>(res: { ok: boolean; status: number; body: T | null }, what: string) {
  if (!res.ok) throw new HttpError("CALL", `${YOUTUBE_ORIGIN}/${what}`, res.status);
  return res.body as T;
}

/** Bytes from a local path or a URL the worker can reach. */
export async function bytesOf(
  source: string,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array<ArrayBuffer>> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetcher(source);
    if (!res.ok) throw new HttpError("GET", source, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
  return new Uint8Array(await readFile(source));
}

const upload = z.object({
  uploadType: z.literal("resumable").default("resumable"),
  part: z.string().default("snippet,status"),
  snippet: z.object({
    title: z.string().min(1).max(100),
    description: z.string().max(5000).default(""),
    tags: z.array(z.string()).max(500).default([]),
    categoryId: z.string().default("22"),
    defaultLanguage: z.string().optional(),
  }),
  status: z
    .object({
      privacyStatus: z.enum(["public", "unlisted", "private"]).default("private"),
      publishAt: z.string().datetime().optional(),
      selfDeclaredMadeForKids: z.boolean().default(false),
    })
    .default({ privacyStatus: "private", selfDeclaredMadeForKids: false }),
  /** The video: a path on the worker or a URL. Not part of the official body (it is the upload's bytes). */
  file: z.string().min(1),
  contentType: z.string().default("video/*"),
});
const thumbnail = z.object({
  videoId: z.string().min(1),
  file: z.string().min(1),
  contentType: z.string().default("image/jpeg"),
});
const read = z
  .object({
    resource: z.enum([
      "videos",
      "channels",
      "playlistItems",
      "search",
      "commentThreads",
      "comments",
      "playlists",
    ]),
  })
  .loose();
const commentThread = z.object({
  part: z.string().default("snippet"),
  snippet: z.object({
    videoId: z.string().min(1),
    topLevelComment: z.object({
      snippet: z.object({ textOriginal: z.string().min(1).max(10000) }),
    }),
  }),
});
const reply = z.object({
  part: z.string().default("snippet"),
  snippet: z.object({ parentId: z.string().min(1), textOriginal: z.string().min(1).max(10000) }),
});
const communityPost = z.object({ text: z.string().min(1).max(5000), image: z.string().optional() });

export const youtubeOAuth: OAuthSpec = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/youtube.readonly",
  ],
  clientId: "GOOGLE_OAUTH_CLIENT_ID",
  clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
  refreshToken: "YOUTUBE_REFRESH_TOKEN",
  params: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  consentFlow: "google/oauth-consent",
};

export const youtube: SiteApi = {
  site: "youtube",
  origin: YOUTUBE_ORIGIN,
  auth: { oauth: youtubeOAuth },
  routes: [
    route({
      method: "POST",
      path: "/upload/youtube/v3/videos",
      summary:
        "Upload a video (resumable): `snippet`, `status`, and `file` (path or URL); answers the video resource",
      request: upload,
      irreversible: true,
      api: async (body, leg) => {
        const { file, contentType, part, uploadType, ...meta } = body;
        const bytes = await bytesOf(file);
        const start = await leg.http.json<unknown>(
          `${YOUTUBE_ORIGIN}/upload/youtube/v3/videos?uploadType=${uploadType}&part=${encodeURIComponent(part)}`,
          {
            method: "POST",
            headers: {
              ...bearer(leg),
              "X-Upload-Content-Type": contentType,
              "X-Upload-Content-Length": String(bytes.byteLength),
            },
            body: meta,
          },
        );
        await must(start, "upload/youtube/v3/videos");
        const location = start.headers.get("location");
        if (!location)
          throw new HttpError(
            "POST",
            `${YOUTUBE_ORIGIN}/upload/youtube/v3/videos`,
            start.status,
            "no upload URL",
          );
        return must(
          await leg.http.json<unknown>(location, {
            method: "PUT",
            headers: { "content-type": contentType },
            raw: bytes,
          }),
          "upload/youtube/v3/videos (bytes)",
        );
      },
    }),
    route({
      method: "POST",
      path: "/upload/youtube/v3/thumbnails/set",
      summary: "Set a video's thumbnail from `file` (path or URL)",
      request: thumbnail,
      api: async ({ videoId, file, contentType }, leg) =>
        must(
          await leg.http.json<unknown>(
            `${YOUTUBE_ORIGIN}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
            {
              method: "POST",
              headers: { ...bearer(leg), "content-type": contentType },
              raw: await bytesOf(file),
            },
          ),
          "upload/youtube/v3/thumbnails/set",
        ),
    }),
    route({
      method: "GET",
      path: "/youtube/v3/{resource}",
      summary:
        "Any read with its own query: `videos?part=statistics&id=`, `channels?mine=true&part=contentDetails`, `playlistItems?playlistId=`, `commentThreads?videoId=`, `search?forMine=true&type=video`",
      request: read,
      api: async ({ resource, ...query }, leg) => {
        const u = new URL(`${YOUTUBE_ORIGIN}/youtube/v3/${resource}`);
        for (const [k, v] of Object.entries(query))
          if (v !== undefined) u.searchParams.set(k, String(v));
        return must(
          await leg.http.json<unknown>(u.toString(), { headers: bearer(leg) }),
          `youtube/v3/${resource}`,
        );
      },
    }),
    route({
      method: "POST",
      path: "/youtube/v3/commentThreads",
      summary: "A top-level comment on a video",
      request: commentThread,
      irreversible: true,
      api: async ({ part, ...body }, leg) =>
        must(
          await leg.http.json<unknown>(
            `${YOUTUBE_ORIGIN}/youtube/v3/commentThreads?part=${encodeURIComponent(part)}`,
            {
              method: "POST",
              headers: bearer(leg),
              body,
            },
          ),
          "youtube/v3/commentThreads",
        ),
    }),
    route({
      method: "POST",
      path: "/youtube/v3/comments",
      summary: "Reply to a comment (`snippet.parentId`)",
      request: reply,
      irreversible: true,
      api: async ({ part, ...body }, leg) =>
        must(
          await leg.http.json<unknown>(
            `${YOUTUBE_ORIGIN}/youtube/v3/comments?part=${encodeURIComponent(part)}`,
            {
              method: "POST",
              headers: bearer(leg),
              body,
            },
          ),
          "youtube/v3/comments",
        ),
    }),
    route({
      method: "POST",
      path: "/studio/communityPosts",
      summary:
        "A community post (no official API; autobrowse-only path, YouTube Studio in the browser)",
      request: communityPost,
      irreversible: true,
      browser: { flow: "youtube/community-post" },
    }),
  ],
  setup: [
    {
      name: "oauth-client",
      makes: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
      how: {
        flow: "google/cloud-oauth-client",
        input: {
          api: "youtube.googleapis.com",
          redirectUri: "http://127.0.0.1:9400/oauth/callback",
        },
      },
      summary:
        "In Google Cloud Console: enable the YouTube Data API v3, create a Web OAuth client with the loopback redirect, keep its id and secret",
    },
    {
      name: "consent",
      makes: ["YOUTUBE_REFRESH_TOKEN"],
      needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
      how: { oauth: youtubeOAuth },
      summary:
        "Consent once as the channel's Google account (offline access); the refresh token is kept",
    },
  ],
};
