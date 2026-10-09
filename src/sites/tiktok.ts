/**
 * TikTok under its own API's shape (open.tiktokapis.com v2): Login Kit for
 * the token, Display API for the account and its videos, Content Posting
 * API for publishing (an unaudited app can only post as private/self,
 * and only to the app's own testers). Comments have no public API, so
 * that route is browser-only. Written from the docs 2026-09-21, unproven
 * until a developer app and an account exist.
 */
import { z } from "zod";
import { HttpError } from "../clients/http.js";
import { WEB_REDIRECT } from "./oauth.js";
import { type ApiLeg, type OAuthSpec, route, type SiteApi } from "./types.js";

export const TIKTOK_ORIGIN = "https://open.tiktokapis.com";

const bearer = (leg: ApiLeg) => ({ authorization: `Bearer ${leg.token}` });

const userInfo = z.object({
  fields: z.string().default("open_id,union_id,avatar_url,display_name,follower_count,video_count"),
});
const VIDEO_FIELDS =
  "id,title,create_time,cover_image_url,share_url,view_count,like_count,comment_count,share_count";
const videoList = z.object({
  fields: z.string().default(VIDEO_FIELDS),
  cursor: z.number().int().optional(),
  max_count: z.number().int().min(1).max(20).default(20),
});
const videoQuery = z.object({
  fields: z.string().default(VIDEO_FIELDS),
  filters: z.object({ video_ids: z.array(z.string().min(1)).min(1).max(20) }),
});
const publishInit = z.object({
  post_info: z.object({
    title: z.string().max(2200).optional(),
    privacy_level: z
      .enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"])
      .default("SELF_ONLY"),
    disable_duet: z.boolean().optional(),
    disable_comment: z.boolean().optional(),
    disable_stitch: z.boolean().optional(),
    video_cover_timestamp_ms: z.number().int().optional(),
    /** The video is AI-generated content. */
    is_aigc: z.boolean().optional(),
    /** Paid partnership: promotes a third party's brand. */
    brand_content_toggle: z.boolean().optional(),
    /** Promotes the creator's own business. */
    brand_organic_toggle: z.boolean().optional(),
  }),
  source_info: z.union([
    z.object({ source: z.literal("PULL_FROM_URL"), video_url: z.string().url() }),
    z.object({
      source: z.literal("FILE_UPLOAD"),
      video_size: z.number().int().positive(),
      chunk_size: z.number().int().positive(),
      total_chunk_count: z.number().int().positive(),
    }),
  ]),
});
const publishStatus = z.object({ publish_id: z.string().min(1) });
const webPost = z.object({
  caption: z.string().max(2200).default(""),
  /** The video the browser leg uploads: a path on the box, or a URL it downloads. */
  file: z.string().min(1),
});
const videoId = z.object({ videoId: z.string().min(1) });
const reply = z.object({
  videoId: z.string().min(1),
  commentId: z.string().min(1),
  text: z.string().min(1).max(150),
});

const profileName = z.object({
  /** The new display name; the handle and profile link stay as they are. */
  name: z.string().trim().min(1).max(30),
});

async function must<T>(res: { ok: boolean; status: number; body: T | null }, what: string) {
  if (!res.ok) throw new HttpError("CALL", `${TIKTOK_ORIGIN}/${what}`, res.status);
  return res.body as T;
}
const withFields = (path: string, fields: string) =>
  `${TIKTOK_ORIGIN}${path}?fields=${encodeURIComponent(fields)}`;

export const tiktokOAuth: OAuthSpec = {
  authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
  tokenUrl: `${TIKTOK_ORIGIN}/v2/oauth/token/`,
  scopes: ["user.info.basic", "user.info.stats", "video.list", "video.publish", "video.upload"],
  scopeSeparator: ",",
  clientIdParam: "client_key",
  clientId: "TIKTOK_CLIENT_KEY",
  clientSecret: "TIKTOK_CLIENT_SECRET",
  refreshToken: "TIKTOK_REFRESH_TOKEN",
  redirect: WEB_REDIRECT,
  consent: { flow: "tiktok/oauth-consent" },
};

export const tiktok: SiteApi = {
  site: "tiktok",
  origin: TIKTOK_ORIGIN,
  probe: { path: "/v2/user/info/" },
  auth: { oauth: tiktokOAuth },
  // Wren's account was made with "Continue with Google" (2026-09-29).
  via: "google",
  routes: [
    route({
      method: "GET",
      path: "/v2/user/info/",
      summary: "The account behind the token (`fields=open_id,display_name,follower_count,…`)",
      request: userInfo,
      api: async ({ fields }, leg) =>
        must(
          await leg.http.json<unknown>(withFields("/v2/user/info/", fields), {
            headers: bearer(leg),
          }),
          "v2/user/info/",
        ),
      browser: { workflow: "tiktok-whoami" },
    }),
    route({
      method: "POST",
      path: "/v2/video/list/",
      summary: "The account's videos with counts, newest first (`max_count`, `cursor`)",
      request: videoList,
      api: async ({ fields, ...body }, leg) =>
        must(
          await leg.http.json<unknown>(withFields("/v2/video/list/", fields), {
            method: "POST",
            headers: bearer(leg),
            body,
          }),
          "v2/video/list/",
        ),
      browser: { workflow: "tiktok-list-posts", input: (b) => ({ count: b.max_count }) },
    }),
    route({
      method: "POST",
      path: "/v2/video/query/",
      summary: "Given videos with their view/like/comment/share counts (`filters.video_ids`)",
      request: videoQuery,
      api: async ({ fields, filters }, leg) =>
        must(
          await leg.http.json<unknown>(withFields("/v2/video/query/", fields), {
            method: "POST",
            headers: bearer(leg),
            body: { filters },
          }),
          "v2/video/query/",
        ),
      browser: { workflow: "tiktok-post-stats", input: (b) => ({ videoIds: b.filters.video_ids }) },
    }),
    route({
      method: "POST",
      path: "/v2/post/publish/video/init/",
      summary:
        "Publish a video from a URL the app's domain owns, or start a chunked upload; answers `publish_id` (unaudited apps: SELF_ONLY)",
      request: publishInit,
      irreversible: true,
      api: async (body, leg) =>
        must(
          await leg.http.json<unknown>(`${TIKTOK_ORIGIN}/v2/post/publish/video/init/`, {
            method: "POST",
            headers: bearer(leg),
            body,
          }),
          "v2/post/publish/video/init/",
        ),
    }),
    route({
      method: "POST",
      path: "/v2/post/publish/status/fetch/",
      summary: "Where a publish stands (`publish_id`)",
      request: publishStatus,
      api: async (body, leg) =>
        must(
          await leg.http.json<unknown>(`${TIKTOK_ORIGIN}/v2/post/publish/status/fetch/`, {
            method: "POST",
            headers: bearer(leg),
            body,
          }),
          "v2/post/publish/status/fetch/",
        ),
    }),
    route({
      method: "POST",
      path: "/web/posts",
      summary:
        "A post from a local video file with a caption, public (no official path for that: the browser leg uploads on tiktok.com)",
      request: webPost,
      irreversible: true,
      browser: { workflow: "tiktok-create-post", uploads: "file" },
    }),
    route({
      method: "GET",
      path: "/web/videos/{videoId}/comments",
      summary: "Comments on a video (no public API; browser)",
      request: videoId,
      browser: { workflow: "tiktok-post-comments" },
    }),
    route({
      method: "POST",
      path: "/web/videos/{videoId}/comments/{commentId}/replies",
      summary: "Reply to a comment (no public API; browser)",
      request: reply,
      irreversible: true,
      browser: { workflow: "tiktok-reply" },
    }),
    route({
      method: "POST",
      path: "/web/profile/name",
      summary:
        "The account's nickname (no API sets it; Edit profile in the browser): `name`; answers `{ before, name, note }`, note = TikTok's lock line. Once every 7 days; the username never changes",
      request: profileName,
      irreversible: true,
      browser: { flow: "tiktok/profile-name" },
    }),
  ],
  setup: [
    {
      name: "developer-app",
      makes: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
      how: {
        workflow: "tiktok-developer-app",
        input: { redirectUri: WEB_REDIRECT },
      },
      summary:
        "On developers.tiktok.com: an app with Login Kit + Content Posting API, the redirect URI, the account as a target user; keep the client key and secret",
    },
    {
      name: "consent",
      makes: ["TIKTOK_REFRESH_TOKEN"],
      needs: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
      how: { oauth: tiktokOAuth },
      summary: "Consent once as the account; the refresh token is kept (365 days)",
    },
  ],
};
