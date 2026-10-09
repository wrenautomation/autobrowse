/**
 * X under its API v2: posts (text, replies, quotes, media), the account,
 * its timeline, a post's metrics, and media upload (an image in one
 * request; a video in chunks with a processing wait). OAuth 2.0 with PKCE
 * and a refresh token (`offline.access`); the token endpoint takes the
 * client as HTTP Basic. X bills every API read, so the read routes answer
 * from the signed-in page (`prefer: "browser"`, flows in x-read.ts), capped
 * per day and paced per account; writes keep the API. Written from the docs
 * 2026-09-22; browser reads proven 2026-09-29 as x@wren.
 */
import { basename, extname } from "node:path";
import { z } from "zod";
import { HttpError } from "../clients/http.js";
import { type ApiLeg, type OAuthSpec, route, type SiteApi } from "./types.js";
import { bytesOf } from "./youtube.js";

export const X_ORIGIN = "https://api.x.com";
const CHUNK = 4 * 1024 * 1024;

const bearer = (leg: ApiLeg) => ({ authorization: `Bearer ${leg.token}` });
const id = z.string().regex(/^[0-9]+$/, "a numeric X id");

const me = z.object({
  "user.fields": z.string().default("id,name,username,public_metrics,verified"),
});
const post = z.object({
  text: z.string().max(25_000).optional(),
  reply: z.object({ in_reply_to_tweet_id: id }).optional(),
  quote_tweet_id: id.optional(),
  media: z.object({ media_ids: z.array(id).min(1).max(4) }).optional(),
  poll: z
    .object({ options: z.array(z.string()).min(2).max(4), duration_minutes: z.number().int() })
    .optional(),
  /** Who may reply; unset, everyone can. */
  reply_settings: z.enum(["following", "mentionedUsers", "subscribers", "verified"]).optional(),
});
const one = z.object({ id });
const timeline = z.object({
  /** A numeric user id; the browser leg also takes a handle. */
  id: z.string().regex(/^([0-9]+|[A-Za-z0-9_]{1,15})$/, "a numeric X id or a handle"),
  max_results: z.coerce.number().int().min(5).max(100).default(10),
  pagination_token: z.string().optional(),
  /** Only posts newer than this one: the cursor a caller keeps. */
  since_id: id.optional(),
  "tweet.fields": z.string().default("id,text,created_at,public_metrics"),
  exclude: z.string().optional(),
});
const byUsername = z.object({
  username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/, "an X handle without the @"),
  "user.fields": z
    .string()
    .default("id,name,username,description,location,url,created_at,public_metrics,verified"),
});
const lookup = z.object({
  id,
  "tweet.fields": z.string().default("id,text,created_at,public_metrics,non_public_metrics"),
  /** `attachments.media_keys` puts the post's media in `includes.media`. */
  expansions: z.string().optional(),
  /**
   * Set, the call goes to the API: only it gives a video's views and playback quartiles
   * (`public_metrics.view_count`, `non_public_metrics`/`organic_metrics` `playback_0_count`..`playback_100_count`).
   */
  "media.fields": z.string().optional(),
});
const search = z.object({
  query: z.string().min(1),
  max_results: z.coerce.number().int().min(10).max(100).default(10),
  "tweet.fields": z.string().default("id,text,created_at,public_metrics,author_id"),
  next_token: z.string().optional(),
  since_id: id.optional(),
});
const upload = z.object({
  /** A local image or video file. */
  file: z.string().min(1),
  media_category: z.enum(["tweet_image", "tweet_video", "tweet_gif"]).optional(),
});

const handle = z.string().regex(/^[A-Za-z0-9_]{1,15}$/, "an X handle without the @");
const follow = z.object({ username: handle, undo: z.boolean().optional() });
const like = z.object({ id, undo: z.boolean().optional() });

/** A text-only reply goes through the page: free, and the API's reply limits don't apply. */
const pageReply = (b: z.infer<typeof post>) =>
  b.reply && b.text && !b.media && !b.poll && !b.quote_tweet_id && !b.reply_settings;

const profileName = z.object({
  /** The new display name; the handle and profile link stay as they are. */
  name: z.string().trim().min(1).max(50),
});

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

async function must<T>(res: { ok: boolean; status: number; body: T | null }, what: string) {
  if (!res.ok)
    throw new HttpError(
      "CALL",
      `${X_ORIGIN}${what}`,
      res.status,
      JSON.stringify(res.body ?? "").slice(0, 300),
    );
  return res.body as T;
}
const withQuery = (path: string, q: Record<string, string | number | undefined>) => {
  const u = new URL(`${X_ORIGIN}${path}`);
  for (const [k, val] of Object.entries(q))
    if (val !== undefined) u.searchParams.set(k, String(val));
  return u.toString();
};
const get = async (leg: ApiLeg, path: string, q: Record<string, string | number | undefined>) =>
  must(await leg.http.json<unknown>(withQuery(path, q), { headers: bearer(leg) }), path);
const send = async (
  leg: ApiLeg,
  method: "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
) =>
  must(
    await leg.http.json<unknown>(`${X_ORIGIN}${path}`, {
      method,
      headers: bearer(leg),
      ...(body ? { body } : {}),
    }),
    path,
  );

/** One multipart/form-data body: text fields and one file part. */
export function multipart(
  fields: Record<string, string>,
  file: { name: string; type: string; bytes: Uint8Array },
): { type: string; body: Uint8Array<ArrayBuffer> } {
  const boundary = `----autobrowse${Math.random().toString(16).slice(2)}`;
  const parts: Uint8Array[] = [];
  const text = (s: string) => new TextEncoder().encode(s);
  for (const [k, v] of Object.entries(fields))
    parts.push(
      text(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  parts.push(
    text(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
    file.bytes,
    text(`\r\n--${boundary}--\r\n`),
  );
  const size = parts.reduce((n, p) => n + p.byteLength, 0);
  const body = new Uint8Array(new ArrayBuffer(size));
  let at = 0;
  for (const p of parts) {
    body.set(p, at);
    at += p.byteLength;
  }
  return { type: `multipart/form-data; boundary=${boundary}`, body };
}

/** An image in one request; a video initialized, appended in chunks, finalized, then waited on. */
async function uploadMedia(
  leg: ApiLeg,
  input: z.infer<typeof upload>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<unknown> {
  // A path on this machine or a URL (a presigned S3 object from wren); the query is not the name.
  const plain = input.file.replace(/[?#].*$/, "");
  const type = MIME[extname(plain).toLowerCase()] ?? "application/octet-stream";
  const category =
    input.media_category ??
    (type.startsWith("video/")
      ? "tweet_video"
      : type === "image/gif"
        ? "tweet_gif"
        : "tweet_image");
  const bytes = await bytesOf(input.file);
  const name = basename(plain);
  if (category === "tweet_image" || (category === "tweet_gif" && bytes.byteLength <= CHUNK)) {
    const form = multipart({ media_category: category, media_type: type }, { name, type, bytes });
    return must(
      await leg.http.json<unknown>(`${X_ORIGIN}/2/media/upload`, {
        method: "POST",
        headers: { ...bearer(leg), "content-type": form.type },
        raw: form.body,
      }),
      "2/media/upload",
    );
  }
  const init = (await send(leg, "POST", "/2/media/upload/initialize", {
    media_type: type,
    total_bytes: bytes.byteLength,
    media_category: category,
  })) as { data?: { id?: string } };
  const mediaId = init.data?.id;
  if (!mediaId) throw new HttpError("CALL", `${X_ORIGIN}/2/media/upload/initialize`, 502, "no id");
  for (let i = 0, seg = 0; i < bytes.byteLength; i += CHUNK, seg++) {
    const form = multipart(
      { segment_index: String(seg) },
      { name, type, bytes: bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength)) },
    );
    must(
      await leg.http.json<unknown>(`${X_ORIGIN}/2/media/upload/${mediaId}/append`, {
        method: "POST",
        headers: { ...bearer(leg), "content-type": form.type },
        raw: form.body,
      }),
      `2/media/upload/${mediaId}/append`,
    );
  }
  let state = (await send(leg, "POST", `/2/media/upload/${mediaId}/finalize`)) as {
    data?: { processing_info?: { state?: string; check_after_secs?: number } };
  };
  // X transcodes a video after the upload; the id is usable once processing succeeds.
  for (let rounds = 0; rounds < 60; rounds++) {
    const info = state.data?.processing_info;
    if (!info || info.state === "succeeded") return state;
    if (info.state === "failed")
      throw new HttpError("CALL", `${X_ORIGIN}/2/media/upload`, 502, "processing failed");
    await sleep((info.check_after_secs ?? 2) * 1000);
    state = (await get(leg, "/2/media/upload", { command: "STATUS", media_id: mediaId })) as never;
  }
  throw new HttpError("CALL", `${X_ORIGIN}/2/media/upload`, 504, "still processing");
}

export const xOAuth: OAuthSpec = {
  authorizeUrl: "https://x.com/i/oauth2/authorize",
  tokenUrl: `${X_ORIGIN}/2/oauth2/token`,
  scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
  clientId: "X_CLIENT_ID",
  clientSecret: "X_CLIENT_SECRET",
  refreshToken: "X_REFRESH_TOKEN",
  /** A token pasted from the developer portal works until it expires (two hours). */
  accessToken: "X_ACCESS_TOKEN",
  pkce: true,
  tokenAuth: "basic",
  identity: { url: `${X_ORIGIN}/2/users/me`, field: "data.username" },
  consent: { flow: "x/oauth-consent" },
};

export const x: SiteApi = {
  site: "x",
  origin: X_ORIGIN,
  probe: { path: "/2/users/me" },
  auth: { oauth: xOAuth },
  // Well under what a person scrolls in a day; reads look like one reader, not a scraper.
  caps: { profile: 150, posts: 100, search: 50, follow: 20, like: 50, reply: 30 },
  pace: { gapMs: 5_000, jitterMs: 10_000 },
  routes: [
    route({
      method: "GET",
      path: "/2/users/me",
      summary: "Who the token is (`user.fields`)",
      request: me,
      api: (q, leg) => get(leg, "/2/users/me", q),
    }),
    route({
      method: "GET",
      path: "/2/users/by/username/{username}",
      summary:
        "A user by handle: id, bio, location, link, follower counts (free: the signed-in page)",
      request: byUsername,
      prefer: "browser",
      meter: () => ({ profile: 1 }),
      browser: { flow: "x/profile" },
      api: ({ username, ...q }, leg) => get(leg, `/2/users/by/username/${username}`, q),
    }),
    route({
      method: "POST",
      path: "/2/tweets",
      summary: "A post: text, a reply (`reply.in_reply_to_tweet_id`), a quote, media ids, a poll",
      request: post,
      irreversible: true,
      prefer: (b) => (pageReply(b) ? "browser" : undefined),
      meter: (b) => (b.reply ? { reply: 1 } : {}),
      browser: {
        flow: "x/reply",
        input: (b) => ({ id: b.reply?.in_reply_to_tweet_id, text: b.text }),
      },
      api: (body, leg) => send(leg, "POST", "/2/tweets", body),
    }),
    route({
      method: "POST",
      path: "/2/users/me/following",
      summary:
        "Follow a user by handle (`undo` unfollows): `data.following` (free: the signed-in page; the free API tier has no follows)",
      request: follow,
      meter: () => ({ follow: 1 }),
      browser: { flow: "x/follow" },
    }),
    route({
      method: "POST",
      path: "/2/users/me/likes",
      summary:
        "Like a post (`id`; `undo` takes it back): `data.liked` (free: the signed-in page; the free API tier has no likes)",
      request: like,
      meter: () => ({ like: 1 }),
      browser: { flow: "x/like" },
    }),
    route({
      method: "DELETE",
      path: "/2/tweets/{id}",
      summary: "Delete a post",
      request: one,
      irreversible: true,
      api: ({ id: tweetId }, leg) => send(leg, "DELETE", `/2/tweets/${tweetId}`),
    }),
    route({
      method: "GET",
      path: "/2/tweets/{id}",
      summary:
        "One post with its metrics (free: the signed-in page; with `media.fields`, the API, for a video's views and playback quartiles)",
      request: lookup,
      prefer: (q) => (q["media.fields"] ? undefined : "browser"),
      meter: () => ({ posts: 1 }),
      browser: { flow: "x/post" },
      api: ({ id: tweetId, ...q }, leg) => get(leg, `/2/tweets/${tweetId}`, q),
    }),
    route({
      method: "GET",
      path: "/2/users/{id}/tweets",
      summary:
        "A user's posts, newest first (`max_results`, `since_id` cursor, `exclude=retweets`; `id` may be a handle; free: the signed-in page)",
      request: timeline,
      prefer: "browser",
      meter: () => ({ posts: 1 }),
      browser: { flow: "x/posts" },
      api: ({ id: userId, ...q }, leg) => get(leg, `/2/users/${userId}/tweets`, q),
    }),
    route({
      method: "GET",
      path: "/2/tweets/search/recent",
      summary:
        "Latest posts matching `query` (X search operators, `max_results`, `since_id` cursor; free: the signed-in page)",
      request: search,
      prefer: "browser",
      meter: () => ({ search: 1 }),
      browser: { flow: "x/search" },
      api: (q, leg) => get(leg, "/2/tweets/search/recent", q),
    }),
    route({
      method: "POST",
      path: "/2/media/upload",
      summary:
        "Upload an image or video (`file`: path or URL) for a post; answers `data.id` (a video is chunked and waited on until processed)",
      request: upload,
      api: (input, leg) => uploadMedia(leg, input),
    }),
    route({
      method: "POST",
      path: "/1.1/account/update_profile.json",
      summary:
        "The account's display name (v1.1 wants OAuth 1.0a, so the Edit profile dialog in the browser): `name`; answers `{ before, name }`. The handle never changes",
      request: profileName,
      irreversible: true,
      browser: { flow: "x/profile-name" },
    }),
  ],
  setup: [
    {
      name: "developer-app",
      makes: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
      how: {
        workflow: "x-developer-app",
        input: { redirectUri: "http://127.0.0.1:9400/oauth/callback" },
      },
      summary:
        "On developer.x.com: a project + app (Free tier posts), user authentication set to OAuth 2.0 confidential client with read+write, the redirect URI; keep the client id and secret",
    },
    {
      name: "consent",
      makes: ["X_REFRESH_TOKEN"],
      needs: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
      how: { oauth: xOAuth },
      summary:
        "Consent once as the account (PKCE); the refresh token is kept and rolls on each mint",
    },
  ],
};
