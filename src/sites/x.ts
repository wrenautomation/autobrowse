/**
 * X under its API v2: posts (text, replies, quotes, media), the account,
 * its timeline, a post's metrics, and media upload (an image in one
 * request; a video in chunks with a processing wait). OAuth 2.0 with PKCE
 * and a refresh token (`offline.access`); the token endpoint takes the
 * client as HTTP Basic. Reads beyond the account's own posts are paid
 * tiers on X's side. Written from the docs 2026-09-22; unproven until a
 * developer app and an account exist.
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
});
const one = z.object({ id });
const timeline = z.object({
  id,
  max_results: z.coerce.number().int().min(5).max(100).default(10),
  pagination_token: z.string().optional(),
  "tweet.fields": z.string().default("id,text,created_at,public_metrics"),
  exclude: z.string().optional(),
});
const lookup = z.object({
  id,
  "tweet.fields": z.string().default("id,text,created_at,public_metrics,non_public_metrics"),
});
const search = z.object({
  query: z.string().min(1),
  max_results: z.coerce.number().int().min(10).max(100).default(10),
  "tweet.fields": z.string().default("id,text,created_at,public_metrics,author_id"),
  next_token: z.string().optional(),
});
const upload = z.object({
  /** A local image or video file. */
  file: z.string().min(1),
  media_category: z.enum(["tweet_image", "tweet_video", "tweet_gif"]).optional(),
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
  if (!res.ok) throw new HttpError("CALL", `${X_ORIGIN}/${what}`, res.status);
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
  auth: { oauth: xOAuth },
  routes: [
    route({
      method: "GET",
      path: "/2/users/me",
      summary: "Who the token is (`user.fields`)",
      request: me,
      api: (q, leg) => get(leg, "/2/users/me", q),
    }),
    route({
      method: "POST",
      path: "/2/tweets",
      summary: "A post: text, a reply (`reply.in_reply_to_tweet_id`), a quote, media ids, a poll",
      request: post,
      irreversible: true,
      api: (body, leg) => send(leg, "POST", "/2/tweets", body),
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
      summary: "One post with its metrics (`tweet.fields`)",
      request: lookup,
      api: ({ id: tweetId, ...q }, leg) => get(leg, `/2/tweets/${tweetId}`, q),
    }),
    route({
      method: "GET",
      path: "/2/users/{id}/tweets",
      summary:
        "A user's posts, newest first (`max_results`, `pagination_token`, `exclude=replies,retweets`)",
      request: timeline,
      api: ({ id: userId, ...q }, leg) => get(leg, `/2/users/${userId}/tweets`, q),
    }),
    route({
      method: "GET",
      path: "/2/tweets/search/recent",
      summary: "Posts from the last 7 days matching `query` (a paid tier on X's side)",
      request: search,
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
