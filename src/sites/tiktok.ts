/**
 * TikTok under its own API's shape (open.tiktokapis.com v2): Login Kit for
 * the token, Display API for the account and its videos, Content Posting
 * API for publishing (Direct Post audited 2026-10-23: public posts).
 * Comments, follows and the nickname have no public API, so those routes
 * are browser-only.
 */
import { z } from "zod";
import { MAX_COMMENTS } from "../browser/flows/tiktok-comments.js";
import { HttpError, type JsonResponse, mustOk } from "../clients/http.js";
import { OAUTH_PROVIDERS } from "../oauth/providers.js";
import { pollWaits } from "./poll.js";
import { type ApiLeg, type OAuthSpec, route, type SiteApi } from "./types.js";
import type { Seen, VerifyGet, VerifyRead } from "./verdict.js";
import { arr, isoOf, rec, sameName, str, text, unclear } from "./verify-kit.js";
import { bytesOf } from "./youtube.js";

export const TIKTOK_ORIGIN = "https://open.tiktokapis.com";
const INIT_URL = `${TIKTOK_ORIGIN}/v2/post/publish/video/init/`;

const bearer = (leg: ApiLeg) => ({ authorization: `Bearer ${leg.token}` });

/** Why a fresh video is not in the list at once. */
const LISTS_LATE =
  "TikTok lists a new video only once it is processed, and never one that is not public";

/** The account's newest videos (a POST that only reads), titled as it posted them. */
async function tiktokVideos(get: VerifyGet): Promise<VerifyRead> {
  const data = rec(rec(await get("/v2/video/list/", { max_count: 20 }, { method: "POST" })).data);
  return {
    rows: arr(data.videos).map((e) => {
      const v = rec(e);
      return {
        words: text(v.title),
        at: isoOf(v.create_time, "s"),
        id: str(v.id),
        url: str(v.share_url),
      };
    }),
    order: "newest",
    complete: data.has_more === false,
  };
}

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
const publishInit = z
  .object({
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
    /** A video at a URL on a domain the app verified. Or give `file` and the route uploads it. */
    source_info: z
      .object({ source: z.literal("PULL_FROM_URL"), video_url: z.string().url() })
      .optional(),
    /** A video file (a path, or a URL it reads): sent by FILE_UPLOAD in chunks. */
    file: z.string().min(1).optional(),
  })
  .refine((b) => !b.source_info !== !b.file, "give one of `source_info` or `file`");

/**
 * TikTok's chunk for a FILE_UPLOAD: 5 to 64 MB each, the last takes the rest (up to 128 MB). A
 * file under two chunks goes whole.
 */
export const TIKTOK_CHUNK = 10 * 1024 * 1024;
const VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** Init by FILE_UPLOAD, then PUT each chunk in order to TikTok's signed upload URL. */
async function fileUpload(
  leg: ApiLeg,
  rest: Record<string, unknown>,
  file: string,
): Promise<unknown> {
  const bytes = await bytesOf(file);
  const size = bytes.byteLength;
  if (size <= 0) throw new HttpError("POST", INIT_URL, 422, "the video is empty");
  const type =
    VIDEO_TYPES[/\.(\w+)(?:[?#].*)?$/.exec(file)?.[1]?.toLowerCase() ?? ""] ?? "video/mp4";
  const whole = size < 2 * TIKTOK_CHUNK;
  const chunk = whole ? size : TIKTOK_CHUNK;
  const count = whole ? 1 : Math.floor(size / TIKTOK_CHUNK);
  const init = (await must(
    await leg.http.json<unknown>(INIT_URL, {
      method: "POST",
      headers: bearer(leg),
      body: {
        ...rest,
        source_info: {
          source: "FILE_UPLOAD",
          video_size: size,
          chunk_size: chunk,
          total_chunk_count: count,
        },
      },
    }),
    "v2/post/publish/video/init/",
  )) as { data?: { publish_id?: string; upload_url?: string } };
  const to = init.data?.upload_url;
  if (!init.data?.publish_id || !to)
    throw new HttpError("POST", INIT_URL, 502, "init answered no upload address");
  for (let i = 0; i < count; i++) {
    const first = i * chunk;
    const last = i === count - 1 ? size - 1 : first + chunk - 1;
    // The upload URL is TikTok's own and signed: the token stays off it.
    await must(
      await leg.http.json<unknown>(to, {
        method: "PUT",
        headers: {
          "content-type": type,
          "content-length": String(last - first + 1),
          "content-range": `bytes ${first}-${last}/${size}`,
        },
        raw: bytes.slice(first, last + 1),
      }),
      "v2/post/publish/video/init/ (bytes)",
    );
  }
  return { data: { publish_id: init.data.publish_id } };
}
/** `wait`: seconds to keep asking until the post is done or failed (at most 120), as a client's own call does. */
const publishStatus = z.object({
  publish_id: z.string().min(1),
  wait: z.number().int().min(0).max(120).optional(),
});
const webPost = z.object({
  caption: z.string().max(2200).default(""),
  /** The video the browser leg uploads: a path on the box, or a URL it downloads. */
  file: z.string().min(1),
  /** Who can see it, as Studio names them: Everyone, Friends, Only you. */
  privacy: z.enum(["everyone", "friends", "only-me"]).default("everyone"),
  /** "Allow users to: Comment". */
  comments: z.boolean().default(true),
  /** "Allow users to: Reuse of content" (duet and stitch together). */
  reuse: z.boolean().default(true),
  /** The "AI-generated content" label. */
  aiGenerated: z.boolean().default(false),
});
const following = z.object({ max: z.coerce.number().int().min(1).max(1000).optional() });

const postComments = z.object({
  videoId: z.string().regex(/^\d+$/, "a video id"),
  username: z.string().min(1).optional(),
  max: z.coerce.number().int().min(1).max(MAX_COMMENTS).default(50),
});
const reply = z.object({
  videoId: z.string().min(1),
  commentId: z.string().min(1),
  text: z.string().min(1).max(150),
});

const profileName = z.object({
  /** The new display name; the handle and profile link stay as they are. */
  name: z.string().trim().min(1).max(30),
});

/** TikTok names the refusal in `error.code` (scope_not_authorized, spam_risk_too_many_posts…). */
const tiktokWhy = (body: unknown): string => {
  const e = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return [e?.code, e?.message]
    .filter((x) => typeof x === "string" && x)
    .join(": ")
    .slice(0, 300);
};
const must = <T>(res: JsonResponse<T>, what: string): T =>
  mustOk(res, `${TIKTOK_ORIGIN}/${what}`, tiktokWhy);
const withFields = (path: string, fields: string) =>
  `${TIKTOK_ORIGIN}${path}?fields=${encodeURIComponent(fields)}`;

/**
 * The Wren app's one registered redirect: wren's portal callback, since the app is shared with the
 * portal's TikTok connect (2026-10-15, the stale wrenautomation.com/oauth/callback was removed for
 * review). The consent walker answers it in the browser, so the portal never sees the code.
 */
export const TIKTOK_REDIRECT = "https://app.wrenautomation.com/oauth/social/tiktok";

export const tiktokOAuth: OAuthSpec = {
  authorizeUrl: OAUTH_PROVIDERS.tiktok.authorize,
  tokenUrl: OAUTH_PROVIDERS.tiktok.token,
  scopes: ["user.info.basic", "user.info.stats", "video.list", "video.publish", "video.upload"],
  scopeSeparator: ",",
  clientIdParam: "client_key",
  clientId: "TIKTOK_CLIENT_KEY",
  clientSecret: "TIKTOK_CLIENT_SECRET",
  refreshToken: "TIKTOK_REFRESH_TOKEN",
  redirect: TIKTOK_REDIRECT,
  consent: { flow: "tiktok/oauth-consent" },
  revoke: { url: `${TIKTOK_ORIGIN}/v2/oauth/revoke/`, token: "access" },
};

export const tiktok: SiteApi = {
  site: "tiktok",
  origin: TIKTOK_ORIGIN,
  probe: { path: "/v2/user/info/" },
  auth: { oauth: tiktokOAuth },
  // Wren's account was made with "Continue with Google" (2026-09-29).
  via: "google",
  caps: {
    // A video's comments, read off its page: a pass every 30 minutes at most.
    comments: 24,
    // Who we follow, read off the profile's Following dialog: once a day is the need.
    following: 4,
    // A video's Studio analytics page: a look per video per day.
    analytics: 60,
  },
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
      path: "/v2/post/publish/creator_info/query/",
      summary:
        "What the account may post now: `privacy_level_options` (only SELF_ONLY until the Direct Post audit passes), the comment/duet/stitch locks, the longest video; TikTok wants it read before each post. Reads only",
      request: z.object({}).strict(),
      api: async (_b, leg) =>
        must(
          await leg.http.json<unknown>(`${TIKTOK_ORIGIN}/v2/post/publish/creator_info/query/`, {
            method: "POST",
            headers: bearer(leg),
            body: {},
          }),
          "v2/post/publish/creator_info/query/",
        ),
    }),
    route({
      method: "POST",
      path: "/v2/post/publish/video/init/",
      summary:
        "Direct Post a video: `file` (a path or URL) goes up by FILE_UPLOAD in chunks; `source_info` PULL_FROM_URL takes a URL on a verified domain. Answers `publish_id`. Read `creator_info` first: it lists the privacy levels the app may use",
      request: publishInit,
      irreversible: true,
      verify: {
        words: (b) => b.post_info.title ?? "",
        read: async (b, get): Promise<VerifyRead | Seen> =>
          b.post_info.title ? tiktokVideos(get) : unclear("the post has no title to look for"),
        lags: () => LISTS_LATE,
      },
      // The API answers the publish id; the video's own id comes only once it is processed.
      sentAs: (o) => ({ id: str(rec(rec(o).data).publish_id), url: null }),
      api: async ({ file, ...body }, leg) =>
        file
          ? fileUpload(leg, body, file)
          : must(
              await leg.http.json<unknown>(INIT_URL, {
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
      api: async ({ wait, ...body }, leg) => {
        const waits = pollWaits((wait ?? 0) * 1000);
        for (let n = 0; ; n++) {
          const b = (await must(
            await leg.http.json<unknown>(`${TIKTOK_ORIGIN}/v2/post/publish/status/fetch/`, {
              method: "POST",
              headers: bearer(leg),
              body,
            }),
            "v2/post/publish/status/fetch/",
          )) as { data?: { status?: string } };
          const status = b.data?.status;
          const pause = waits[n];
          if (status === "PUBLISH_COMPLETE" || status === "FAILED" || pause === undefined) return b;
          await new Promise((ok) => setTimeout(ok, pause));
        }
      },
    }),
    route({
      method: "POST",
      path: "/web/posts",
      summary:
        "A post from a video file (a path, or a URL it downloads) with a caption, on TikTok Studio (a fallback; `/v2/post/publish/video/init/` posts by the API): `privacy` everyone|friends|only-me (default everyone), `comments`, `reuse` (default on), `aiGenerated`; answers `{ id, url, profile, note? }`, id null when the post went out but the profile does not list it yet",
      request: webPost,
      irreversible: true,
      verify: {
        words: (b) => b.caption,
        read: async (b, get): Promise<VerifyRead | Seen> =>
          b.caption ? tiktokVideos(get) : unclear("the post has no caption to look for"),
        lags: () => LISTS_LATE,
      },
      sentAs: (o) => ({ id: str(rec(o).id), url: str(rec(o).url) }),
      browser: { flow: "tiktok/create-post", uploads: "file" },
    }),
    route({
      method: "GET",
      path: "/web/following",
      summary:
        "Every account ours follows, read off the signed-in profile's Following dialog (no public API lists follows): `{ data: [{ username, name }], meta: { result_count, listed } }`; `listed` is the profile's own count (`max`, default 1000). Reads only",
      request: following,
      meter: () => ({ following: 1 }),
      browser: { flow: "tiktok/following" },
    }),
    route({
      method: "GET",
      path: "/web/videos/{videoId}/comments",
      summary:
        "Comments on a video, read from the page's own comment calls (no public API; browser): `username` (the video's handle, optional), `max` (default 50, at most 100); answers `{ videoId, url, comments: [{ id, text, at, author, authorName, authorId, parentId, creator, likes }] }`, newest first. Reads only",
      request: postComments,
      meter: () => ({ comments: 1 }),
      browser: { flow: "tiktok/post-comments" },
    }),
    route({
      method: "GET",
      path: "/web/videos/{videoId}/analytics",
      summary:
        "A video's numbers off its TikTok Studio analytics page, read from the page's own insight calls (no API; browser; our own videos only): durationSecs, views, uniqueViewers, totalPlaySecs, avgWatchSecs, finishRate, newFollowers, retention, sources, searchTerms, age, gender, location (lists of `{ key, value }`, TikTok's keys and shares), followerShare, nonFollowerShare, newViewerShare, returnViewerShare; null when TikTok shows none (most fields wait for 100 views); `other` names unmapped fields with data. Reads only",
      request: z.object({ videoId: z.string().regex(/^\d+$/, "a video id") }),
      meter: () => ({ analytics: 1 }),
      browser: { flow: "tiktok/video-analytics" },
    }),
    route({
      method: "POST",
      path: "/web/videos/{videoId}/comments/{commentId}/replies",
      summary: "Reply to a comment (no public API; browser)",
      request: reply,
      irreversible: true,
      verify: {
        words: (b) => b.text,
        read: async (b, get): Promise<VerifyRead> => {
          // On our own video the page marks our comments (`creator`); on another's, the name does.
          // A failed whoami leaves only the mark.
          const info = await get("/v2/user/info/").catch(() => null);
          const name = str(rec(rec(rec(info).data).user).display_name);
          const r = rec(await get(`/web/videos/${b.videoId}/comments`, { max: 100 }));
          return {
            rows: arr(r.comments).map((e) => {
              const c = rec(e);
              return {
                words: text(c.text),
                at: isoOf(c.at),
                id: str(c.id),
                url: null,
                // A reply has a parent; a top-level comment is not our reply.
                mine: (c.creator === true || sameName(c.authorName, name)) && !!str(c.parentId),
              };
            }),
            // Replies load only by "View replies" clicks, so the read is never the whole thread.
            order: "ranked",
            complete: false,
          };
        },
      },
      browser: { workflow: "tiktok-reply" },
    }),
    route({
      method: "POST",
      path: "/web/profile/name",
      summary:
        "The account's nickname (no API sets it; Edit profile in the browser): `name`; answers `{ before, name, note }`, note = TikTok's lock line. Once every 7 days; the username never changes",
      request: profileName,
      irreversible: true,
      verify: { none: "a name set is idempotent: a repeat sets the same name" },
      browser: { flow: "tiktok/profile-name" },
    }),
  ],
  setup: [
    {
      name: "developer-app",
      makes: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
      how: {
        workflow: "tiktok-developer-app",
        input: { redirectUri: TIKTOK_REDIRECT },
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
