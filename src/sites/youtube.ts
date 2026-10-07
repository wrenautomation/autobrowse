/**
 * YouTube under the Data API v3's shape: resumable upload at
 * `/upload/youtube/v3/videos`, thumbnails, any `GET /youtube/v3/{resource}`
 * with its own query, comments. The API covers the channel; only community
 * posts and Studio-only settings need the browser, and those routes say
 * they have no official path.
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import { currentCall } from "../browser/attempt.js";
import { HttpError } from "../clients/http.js";
import { type ApiLeg, type OAuthSpec, route, type SiteApi, SiteError } from "./types.js";
import { once } from "./uploads.js";

export const YOUTUBE_ORIGIN = "https://www.googleapis.com";

/**
 * Which channel these writes belong on. A Google account can own several
 * channels, and the account a token was consented as decides which one an
 * upload lands on — so a stale consent quietly posts Wren's video to a
 * person's own channel. Every write checks the token's channel against this
 * name first and refuses when it cannot prove they match.
 */
export const YOUTUBE_CHANNEL = "YOUTUBE_CHANNEL_ID";

/** One channel lookup per bearer: a token is one account, and it does not change mid-process. */
const channelOf = new Map<string, string>();
const REMEMBERED = 4;

async function channelIdFor(leg: ApiLeg): Promise<string> {
  const seen = channelOf.get(leg.token);
  if (seen) return seen;
  const r = await leg.http.json<{ items?: Array<{ id?: string }> }>(
    `${YOUTUBE_ORIGIN}/youtube/v3/channels?part=id&mine=true`,
    { headers: bearer(leg) },
  );
  const id = r.ok ? r.body?.items?.[0]?.id : undefined;
  if (!id)
    throw new SiteError(
      409,
      "the stored YouTube token owns no channel (or cannot be read): consent again as the account that owns the channel",
    );
  if (channelOf.size >= REMEMBERED) channelOf.clear();
  channelOf.set(leg.token, id);
  return id;
}

/** Throws unless the token's own channel is the configured one. Reads are untouched. */
export async function onTheRightChannel(leg: ApiLeg): Promise<void> {
  const want = leg.env(YOUTUBE_CHANNEL);
  if (!want)
    throw new SiteError(
      409,
      `set ${YOUTUBE_CHANNEL} to the channel these posts belong on before writing (\`site call youtube GET /youtube/v3/channels\` with \`{"mine":true,"part":"id,snippet"}\` lists what this token owns)`,
    );
  const mine = await channelIdFor(leg);
  if (mine !== want)
    throw new SiteError(
      409,
      `this token is on channel ${mine}, not ${YOUTUBE_CHANNEL}=${want}: consent again as the account that owns it (\`site setup youtube consent --account <address>\`)`,
    );
}

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

/** A video body: a local file streams from disk (videos run to GBs), a URL is read whole. */
interface Video {
  length: number;
  /** The bytes from `from` on: a resumed upload sends only the rest. */
  open: (from: number) => Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;
}

async function videoOf(source: string): Promise<Video> {
  if (/^https?:\/\//.test(source)) {
    const bytes = await bytesOf(source);
    return { length: bytes.byteLength, open: (from) => bytes.slice(from) };
  }
  const { size } = await stat(source);
  return {
    length: size,
    open: (from) =>
      Readable.toWeb(createReadStream(source, { start: from })) as ReadableStream<Uint8Array>,
  };
}

/** A multipart/related body: the JSON metadata part, then the media part (Google's multipart upload). */
export function related(
  meta: unknown,
  media: { type: string; bytes: Uint8Array },
): { type: string; body: Uint8Array<ArrayBuffer> } {
  const boundary = `autobrowse${Math.random().toString(16).slice(2)}`;
  const text = (s: string) => new TextEncoder().encode(s);
  const parts = [
    text(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    ),
    text(`--${boundary}\r\nContent-Type: ${media.type}\r\n\r\n`),
    media.bytes,
    text(`\r\n--${boundary}--\r\n`),
  ];
  const body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    body.set(p, at);
    at += p.byteLength;
  }
  return { type: `multipart/related; boundary=${boundary}`, body };
}

/** The bytes PUT gets this long: ~2 GB at a slow uplink. A stream is not retried; a dropped one resumes. */
const VIDEO_PUT_MS = 2 * 60 * 60_000;
/** Times one call resumes a dropped PUT before it gives up and Restate reruns it (which resumes too). */
const RESUMES = 5;

/** Where a session stands: finished (its resource), the next byte it wants, or gone (start again). */
type Standing = { done: unknown } | { next: number } | null;

/** Asks a resumable session how far it got (Google's empty PUT with `bytes *\/<total>`). */
async function standing(leg: ApiLeg, session: string, total: number): Promise<Standing> {
  const r = await leg.http.json<unknown>(session, {
    method: "PUT",
    headers: { "content-range": `bytes */${total}` },
    raw: new Uint8Array(0),
  });
  if (r.status === 200 || r.status === 201) return { done: r.body };
  if (r.status === 404 || r.status === 410) return null;
  if (r.status !== 308) await must(r, "upload/youtube/v3/videos (status)");
  const got = /bytes=0-(\d+)/.exec(r.headers.get("range") ?? "");
  return { next: got ? Number(got[1]) + 1 : 0 };
}

/** Sends the bytes from `from` on; a connection that drops mid-stream asks the session and goes on. */
async function sendFrom(
  leg: ApiLeg,
  session: string,
  video: Video,
  contentType: string,
  from: number,
): Promise<unknown> {
  let at = from;
  for (let n = 0; ; n += 1) {
    try {
      return await must(
        await leg.http.json<unknown>(session, {
          method: "PUT",
          headers: {
            "content-type": contentType,
            "content-length": String(video.length - at),
            ...(at > 0
              ? { "content-range": `bytes ${at}-${video.length - 1}/${video.length}` }
              : {}),
          },
          raw: video.open(at),
          timeoutMs: VIDEO_PUT_MS,
        }),
        "upload/youtube/v3/videos (bytes)",
      );
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 0 || n >= RESUMES) throw err;
      const now = await standing(leg, session, video.length);
      if (!now) throw err;
      if ("done" in now) return now.done;
      at = now.next;
    }
  }
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
    /** The spoken language (BCP-47). */
    defaultAudioLanguage: z.string().optional(),
  }),
  status: z
    .object({
      privacyStatus: z.enum(["public", "unlisted", "private"]).default("private"),
      publishAt: z.string().datetime().optional(),
      selfDeclaredMadeForKids: z.boolean().default(false),
      /** Altered or synthetic content a viewer could take as real. */
      containsSyntheticMedia: z.boolean().optional(),
    })
    .default({ privacyStatus: "private", selfDeclaredMadeForKids: false }),
  /** The video: a path on the worker or a URL. Not part of the official body (it is the upload's bytes). */
  file: z.string().min(1),
  contentType: z.string().default("video/*"),
  /** Tell subscribers about the upload. A query parameter, never in the body; unset, YouTube notifies. */
  notifySubscribers: z.boolean().optional(),
});
/** A video's own fields changed (videos.update): each part sent replaces that part whole. */
const videoUpdate = z
  .object({
    id: z.string().min(1),
    snippet: upload.shape.snippet.optional(),
    status: z
      .object({
        privacyStatus: z.enum(["public", "unlisted", "private"]),
        publishAt: z.string().datetime().optional(),
        selfDeclaredMadeForKids: z.boolean().default(false),
        containsSyntheticMedia: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((v) => v.snippet || v.status, "send `snippet`, `status` or both");
const thumbnail = z.object({
  videoId: z.string().min(1),
  file: z.string().min(1),
  contentType: z.string().default("image/jpeg"),
});
const caption = z.object({
  videoId: z.string().min(1),
  /** BCP-47, e.g. `en` or `pt-BR`. */
  language: z.string().min(2),
  name: z.string().max(150).default(""),
  /** The caption track (SRT, VTT, SBV...): a path on the worker or a URL. */
  file: z.string().min(1),
  contentType: z.string().default("application/octet-stream"),
});
const playlistItem = z.object({
  playlistId: z.string().min(1),
  videoId: z.string().min(1),
});
const banner = z.object({
  file: z.string().min(1),
  contentType: z.string().default("image/png"),
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
      "subscriptions",
      "captions",
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
  consent: { flow: "google/oauth-consent" },
};

export const youtube: SiteApi = {
  site: "youtube",
  origin: YOUTUBE_ORIGIN,
  probe: { path: "/youtube/v3/channels", input: { part: "id", mine: true } },
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
        await onTheRightChannel(leg);
        const { file, contentType, part, uploadType, notifySubscribers, ...meta } = body;
        const video = await videoOf(file);
        // A rerun of this call (Restate, after a dropped connection) resumes its session.
        const call = currentCall();
        return once(call, async () => {
          const kept = call ? (leg.uploads?.get(call) ?? null) : null;
          const now = kept ? await standing(leg, kept, video.length) : null;
          if (kept && now)
            return "done" in now ? now.done : sendFrom(leg, kept, video, contentType, now.next);
          const notify =
            notifySubscribers === undefined ? "" : `&notifySubscribers=${notifySubscribers}`;
          const start = await leg.http.json<unknown>(
            `${YOUTUBE_ORIGIN}/upload/youtube/v3/videos?uploadType=${uploadType}&part=${encodeURIComponent(part)}${notify}`,
            {
              method: "POST",
              headers: {
                ...bearer(leg),
                "X-Upload-Content-Type": contentType,
                "X-Upload-Content-Length": String(video.length),
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
          if (call) leg.uploads?.set(call, location);
          return sendFrom(leg, location, video, contentType, 0);
        });
      },
    }),
    route({
      method: "POST",
      path: "/upload/youtube/v3/thumbnails/set",
      summary: "Set a video's thumbnail from `file` (path or URL)",
      request: thumbnail,
      api: async ({ videoId, file, contentType }, leg) => {
        await onTheRightChannel(leg);
        return must(
          await leg.http.json<unknown>(
            `${YOUTUBE_ORIGIN}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
            {
              method: "POST",
              headers: { ...bearer(leg), "content-type": contentType },
              raw: await bytesOf(file),
            },
          ),
          "upload/youtube/v3/thumbnails/set",
        );
      },
    }),
    route({
      method: "POST",
      path: "/upload/youtube/v3/captions",
      summary:
        "Add a caption track to a video from `file` (path or URL), with `language` (BCP-47) and `name`; answers the caption resource",
      request: caption,
      api: async ({ videoId, language, name, file, contentType }, leg) => {
        await onTheRightChannel(leg);
        const form = related(
          { snippet: { videoId, language, name, isDraft: false } },
          { type: contentType, bytes: await bytesOf(file) },
        );
        return must(
          await leg.http.json<unknown>(
            `${YOUTUBE_ORIGIN}/upload/youtube/v3/captions?uploadType=multipart&part=snippet`,
            {
              method: "POST",
              headers: { ...bearer(leg), "content-type": form.type },
              raw: form.body,
            },
          ),
          "upload/youtube/v3/captions",
        );
      },
    }),
    route({
      method: "PUT",
      path: "/youtube/v3/videos",
      summary:
        "Change a video (`id`, and `snippet` and/or `status`: each part sent replaces that part); answers the video",
      request: videoUpdate,
      api: async (body, leg) => {
        await onTheRightChannel(leg);
        const part = (["snippet", "status"] as const).filter((k) => body[k]).join(",");
        return must(
          await leg.http.json<unknown>(`${YOUTUBE_ORIGIN}/youtube/v3/videos?part=${part}`, {
            method: "PUT",
            headers: bearer(leg),
            body,
          }),
          "youtube/v3/videos",
        );
      },
    }),
    route({
      method: "DELETE",
      path: "/youtube/v3/videos",
      summary: "Delete a video (`id`) for good; answers `{ deleted: id }`",
      request: z.object({ id: z.string().min(1) }),
      irreversible: true,
      api: async ({ id }, leg) => {
        await onTheRightChannel(leg);
        const r = await leg.http.json<unknown>(
          `${YOUTUBE_ORIGIN}/youtube/v3/videos?id=${encodeURIComponent(id)}`,
          { method: "DELETE", headers: bearer(leg) },
        );
        await must(r, "youtube/v3/videos (delete)");
        return { deleted: id };
      },
    }),
    route({
      method: "POST",
      path: "/youtube/v3/playlistItems",
      summary: "Add a video to a playlist (`playlistId`, `videoId`); answers the playlist item",
      request: playlistItem,
      api: async ({ playlistId, videoId }, leg) => {
        await onTheRightChannel(leg);
        return must(
          await leg.http.json<unknown>(`${YOUTUBE_ORIGIN}/youtube/v3/playlistItems?part=snippet`, {
            method: "POST",
            headers: bearer(leg),
            body: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } },
          }),
          "youtube/v3/playlistItems",
        );
      },
    }),
    route({
      method: "POST",
      path: "/youtube/v3/channelBanner",
      summary:
        "Set the channel's banner from `file` (path or URL; 2048x1152 min, 6 MB max): uploads it, then points brandingSettings at it, the rest of brandingSettings kept",
      request: banner,
      api: async ({ file, contentType }, leg) => {
        await onTheRightChannel(leg);
        const { url } = await must(
          await leg.http.json<{ url: string }>(
            `${YOUTUBE_ORIGIN}/upload/youtube/v3/channelBanners/insert?uploadType=media`,
            {
              method: "POST",
              headers: { ...bearer(leg), "content-type": contentType },
              raw: await bytesOf(file),
            },
          ),
          "upload/youtube/v3/channelBanners/insert",
        );
        const { items } = await must(
          await leg.http.json<{
            items?: Array<{ id: string; brandingSettings?: Record<string, unknown> }>;
          }>(`${YOUTUBE_ORIGIN}/youtube/v3/channels?mine=true&part=brandingSettings`, {
            headers: bearer(leg),
          }),
          "youtube/v3/channels",
        );
        const channel = items?.[0];
        if (!channel) throw new HttpError("CALL", `${YOUTUBE_ORIGIN}/youtube/v3/channels`, 404);
        // An update replaces all of brandingSettings: send back what is there, with the new image.
        const branding = channel.brandingSettings ?? {};
        await must(
          await leg.http.json<unknown>(
            `${YOUTUBE_ORIGIN}/youtube/v3/channels?part=brandingSettings`,
            {
              method: "PUT",
              headers: bearer(leg),
              body: {
                id: channel.id,
                brandingSettings: {
                  ...branding,
                  image: { ...((branding.image as object) ?? {}), bannerExternalUrl: url },
                },
              },
            },
          ),
          "youtube/v3/channels",
        );
        return { channel: channel.id, bannerUrl: url };
      },
    }),
    route({
      method: "GET",
      path: "/youtube/v3/{resource}",
      summary:
        "Any read with its own query: `videos?part=statistics&id=`, `channels?mine=true&part=contentDetails`, `playlistItems?playlistId=`, `commentThreads?videoId=`, `search?forMine=true&type=video`, `subscriptions?myRecentSubscribers=true&part=subscriberSnippet`, `captions?part=snippet&videoId=`",
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
      api: async ({ part, ...body }, leg) => {
        await onTheRightChannel(leg);
        return must(
          await leg.http.json<unknown>(
            `${YOUTUBE_ORIGIN}/youtube/v3/commentThreads?part=${encodeURIComponent(part)}`,
            {
              method: "POST",
              headers: bearer(leg),
              body,
            },
          ),
          "youtube/v3/commentThreads",
        );
      },
    }),
    route({
      method: "POST",
      path: "/youtube/v3/comments",
      summary: "Reply to a comment (`snippet.parentId`)",
      request: reply,
      irreversible: true,
      api: async ({ part, ...body }, leg) => {
        await onTheRightChannel(leg);
        return must(
          await leg.http.json<unknown>(
            `${YOUTUBE_ORIGIN}/youtube/v3/comments?part=${encodeURIComponent(part)}`,
            {
              method: "POST",
              headers: bearer(leg),
              body,
            },
          ),
          "youtube/v3/comments",
        );
      },
    }),
    route({
      method: "POST",
      path: "/studio/communityPosts",
      summary:
        "A community post (no official API; autobrowse-only path, YouTube Studio in the browser)",
      request: communityPost,
      irreversible: true,
      browser: {
        flow: "google/youtube-community-post",
        input: (i, env) => ({ ...i, channel: env(YOUTUBE_CHANNEL) }),
      },
    }),
  ],
  setup: [
    {
      name: "project",
      makes: ["GOOGLE_CLOUD_PROJECT"],
      how: { workflow: "google-cloud-project", input: { name: "wren" } },
      summary: "In Google Cloud Console: a project to hold the OAuth client; its id is kept",
      purpose: "pays",
    },
    {
      name: "oauth-client",
      makes: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
      needs: ["GOOGLE_CLOUD_PROJECT"],
      how: {
        workflow: "google-cloud-oauth-client",
        input: {
          project: { env: "GOOGLE_CLOUD_PROJECT" },
          api: "youtube.googleapis.com",
          appName: "Wren Automation",
          email: { account: true },
          clientName: "autobrowse",
          redirectUri: "http://127.0.0.1:9400/oauth/callback",
        },
      },
      summary:
        "In Google Cloud Console: enable the YouTube Data API v3, configure the consent screen (external, testing, one test user), create a Web OAuth client with the loopback redirect, keep its id and secret",
      purpose: "pays",
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
