/**
 * Instagram under the "Instagram API with Instagram Login" shape
 * (graph.instagram.com): a professional account (creator/business) signs
 * in on instagram.com, no Facebook Page needed. Publishing is two calls
 * (a media container, then publish); insights, comments and replies are
 * covered. What the API has no path for (a personal account, stories from
 * a file) goes through the browser. Written from the docs 2026-09-21,
 * unproven until a developer app and an account exist.
 */
import { z } from "zod";
import { type JsonResponse, mustOk } from "../clients/http.js";
import { OAUTH_PROVIDERS } from "../oauth/providers.js";
import { WEB_REDIRECT } from "./oauth.js";
import { bearer, type OAuthSpec, route, type SiteApi } from "./types.js";
import type { Seen, VerifyGet, VerifyRead } from "./verdict.js";
import { arr, hasNext, isoOf, rec, str, text, unclear } from "./verify-kit.js";

/**
 * Whose account the browser legs post as. The composer follows whoever the
 * profile is signed in as, so without it a post could land on a personal
 * account; the flow refuses rather than guess. Same guard as YOUTUBE_CHANNEL_ID.
 */
export const INSTAGRAM_ACCOUNT = "INSTAGRAM_ACCOUNT";
export const INSTAGRAM_ORIGIN = "https://graph.instagram.com";
/** Graph API versions live about two years. */
export const INSTAGRAM_VERSION = "v23.0";

const id = z.string().regex(/^[0-9]+$/, "a numeric Instagram id");

const me = z.object({ fields: z.string().default("user_id,username,account_type") });
const container = z.object({
  igUserId: id,
  image_url: z.string().url().optional(),
  video_url: z.string().url().optional(),
  media_type: z.enum(["IMAGE", "REELS", "STORIES", "CAROUSEL"]).optional(),
  caption: z.string().max(2200).optional(),
  children: z.array(id).optional(),
  is_carousel_item: z.boolean().optional(),
  cover_url: z.string().url().optional(),
  share_to_feed: z.boolean().optional(),
  /** A Reel's cover frame, in ms from the start (ignored when `cover_url` is set). */
  thumb_offset: z.number().int().min(0).optional(),
  /** Up to three accounts invited as collaborators. */
  collaborators: z
    .array(z.string().regex(/^[A-Za-z0-9._]{1,30}$/, "an Instagram username"))
    .min(1)
    .max(3)
    .optional(),
  /** A Reel's audio name (only for original audio). */
  audio_name: z.string().min(1).optional(),
});
const publish = z.object({ igUserId: id, creation_id: id });
const listMedia = z.object({
  igUserId: id,
  fields: z
    .string()
    .default("id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().optional(),
});
const insights = z.object({
  mediaId: id,
  metric: z.string().default("reach,saved,likes,comments,shares,views"),
});
const comments = z.object({
  mediaId: id,
  fields: z.string().default("id,text,username,timestamp,like_count,replies"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().optional(),
});
const reply = z.object({ commentId: id, message: z.string().min(1).max(2200) });
const replies = z.object({
  commentId: id,
  fields: z.string().default("id,text,username,timestamp"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().optional(),
});
const containerState = z.object({
  containerId: id,
  fields: z.string().default("id,status_code"),
});
const webPost = z.object({
  caption: z.string().max(2200).default(""),
  /** The image or video the browser leg uploads: a path on the box, or a URL it downloads. */
  file: z.string().min(1),
});

const username = z.string().regex(/^[A-Za-z0-9._]{1,30}$/, "an Instagram username without the @");
const shortcode = z.string().regex(/^[\w-]{5,40}$/, "a post code, as in /p/<code>/");
const webFollow = z.object({ username, undo: z.boolean().optional() });
const webLike = z.object({ shortcode, undo: z.boolean().optional() });
const webComment = z.object({ shortcode, text: z.string().trim().min(1).max(2200) });
const webComments = z.object({
  shortcode,
  max: z.coerce.number().int().min(1).max(200).default(100),
});
const webSearch = z.object({
  q: z.string().trim().min(1).max(100),
  max: z.coerce.number().int().min(1).max(30).default(12),
});

const feed = z.object({ max: z.coerce.number().int().min(1).max(50).default(20) });

const following = z.object({ max: z.coerce.number().int().min(1).max(1000).optional() });

const profileName = z.object({
  /** The new display name; the handle and profile link stay as they are. */
  name: z.string().trim().min(1).max(30),
});

const must = <T>(res: JsonResponse<T>, what: string): T =>
  mustOk(res, `${INSTAGRAM_ORIGIN}/${what}`);
const v = (path: string) => `${INSTAGRAM_ORIGIN}/${INSTAGRAM_VERSION}/${path}`;
/** The signed-in account: its numeric id and username (`GET /me`). */
async function ownAccount(
  look: VerifyGet,
): Promise<{ id: string; username: string | null } | null> {
  const me = rec(await look("/me"));
  const id = str(me.user_id) ?? str(me.id);
  return id ? { id, username: str(me.username) } : null;
}

const withQuery = (url: string, q: Record<string, string | number | undefined>) => {
  const u = new URL(url);
  for (const [k, val] of Object.entries(q))
    if (val !== undefined) u.searchParams.set(k, String(val));
  return u.toString();
};

export const instagramOAuth: OAuthSpec = {
  authorizeUrl: OAUTH_PROVIDERS.instagram.authorize,
  tokenUrl: OAUTH_PROVIDERS.instagram.token,
  scopes: [
    "instagram_business_basic",
    "instagram_business_content_publish",
    "instagram_business_manage_comments",
    "instagram_business_manage_insights",
  ],
  scopeSeparator: ",",
  clientId: "INSTAGRAM_CLIENT_ID",
  clientSecret: "INSTAGRAM_CLIENT_SECRET",
  // No refresh token: the long-lived token (60 days) is kept; consent again when it lapses.
  refreshToken: "INSTAGRAM_REFRESH_TOKEN",
  accessToken: "INSTAGRAM_ACCESS_TOKEN",
  // Meta takes neither http nor localhost: the Meta app's https redirect, answered by the browser.
  redirect: WEB_REDIRECT,
  longLived: {
    url: `${INSTAGRAM_ORIGIN}/access_token`,
    fields: { grant_type: "ig_exchange_token" },
    tokenParam: "access_token",
  },
  consent: { flow: "instagram/oauth-consent" },
};

export const instagram: SiteApi = {
  site: "instagram",
  origin: INSTAGRAM_ORIGIN,
  probe: { path: "/me" },
  auth: { oauth: instagramOAuth },
  // Acts on others' accounts go through the page (no API does them): a person's pace, per account.
  caps: {
    follow: 15,
    like: 40,
    comment: 10,
    post: 60,
    comments: 40,
    search: 10,
    following: 8,
    feed: 12,
  },
  pace: { gapMs: 8_000, jitterMs: 12_000 },
  routes: [
    route({
      method: "GET",
      path: "/me",
      summary: "Who the token is: `user_id` is the ig-user-id the other routes take",
      request: me,
      api: async ({ fields }, leg) =>
        must(
          await leg.http.json<unknown>(withQuery(v("me"), { fields }), { headers: bearer(leg) }),
          "me",
        ),
      browser: { workflow: "instagram-whoami" },
    }),
    route({
      method: "POST",
      path: "/{igUserId}/media",
      summary:
        "A media container from a public image/video URL (step 1 of publishing); answers its id",
      request: container,
      api: async ({ igUserId, ...body }, leg) =>
        must(
          await leg.http.json<unknown>(v(`${igUserId}/media`), {
            method: "POST",
            headers: bearer(leg),
            body,
          }),
          "{igUserId}/media",
        ),
    }),
    route({
      method: "POST",
      path: "/{igUserId}/media_publish",
      summary: "Publish a container (step 2); answers the media id",
      request: publish,
      irreversible: true,
      verify: {
        // The container says whether it was published: a state, not words.
        words: () => "",
        read: async (b, look): Promise<Seen> => {
          const status = text(
            rec(await look(`/containers/${b.creation_id}`, { fields: "id,status_code" }))
              .status_code,
          );
          if (status === "PUBLISHED") return { seen: "found", id: null, url: null, at: null };
          // Never published, and never will be: its time is out or it failed.
          if (status === "ERROR" || status === "EXPIRED") return { seen: "absent" };
          // Ready or still processing: the publish may yet land.
          return unclear(`the container is ${status || "in an unknown state"}`);
        },
      },
      sentAs: (o) => ({ id: str(rec(o).id), url: null }),
      api: async ({ igUserId, creation_id }, leg) =>
        must(
          await leg.http.json<unknown>(v(`${igUserId}/media_publish`), {
            method: "POST",
            headers: bearer(leg),
            body: { creation_id },
          }),
          "{igUserId}/media_publish",
        ),
    }),
    route({
      method: "POST",
      path: "/web/posts",
      summary:
        "A post from a local file with a caption (no official path: the API wants a public URL; the browser leg uploads)",
      request: webPost,
      irreversible: true,
      verify: {
        words: (b) => b.caption,
        read: async (b, look): Promise<VerifyRead | Seen> => {
          if (!b.caption.trim()) return unclear("the post has no caption to look for");
          const own = await ownAccount(look);
          if (!own) return unclear("the account's id did not come back");
          const r = await look(`/${own.id}/media`, {
            fields: "id,caption,timestamp,permalink",
            limit: 25,
          });
          return {
            rows: arr(rec(r).data).map((e) => {
              const m = rec(e);
              return {
                words: text(m.caption),
                at: isoOf(m.timestamp),
                id: str(m.id),
                url: str(m.permalink),
              };
            }),
            order: "newest",
            complete: !hasNext(r),
          };
        },
        lags: () => "Instagram lists a video or Reel only once it is processed",
      },
      browser: {
        flow: "instagram/create-post",
        input: (i, env) => ({ ...i, account: env(INSTAGRAM_ACCOUNT) }),
        uploads: "file",
      },
    }),
    route({
      method: "GET",
      path: "/{igUserId}/media",
      summary: "The account's posts, newest first (`fields`, `limit`, `after` cursor)",
      request: listMedia,
      api: async ({ igUserId, ...q }, leg) =>
        must(
          await leg.http.json<unknown>(withQuery(v(`${igUserId}/media`), q), {
            headers: bearer(leg),
          }),
          "{igUserId}/media",
        ),
      browser: { workflow: "instagram-list-posts", input: (q) => ({ limit: q.limit }) },
    }),
    route({
      method: "GET",
      path: "/{mediaId}/insights",
      summary: "A post's metrics (`metric=reach,saved,likes,comments,shares,views`)",
      request: insights,
      api: async ({ mediaId, metric }, leg) =>
        must(
          await leg.http.json<unknown>(withQuery(v(`${mediaId}/insights`), { metric }), {
            headers: bearer(leg),
          }),
          "{mediaId}/insights",
        ),
      browser: { workflow: "instagram-post-stats" },
    }),
    route({
      method: "GET",
      path: "/{mediaId}/comments",
      summary: "Comments on a post (`fields`, `limit`, `after`)",
      request: comments,
      api: async ({ mediaId, ...q }, leg) =>
        must(
          await leg.http.json<unknown>(withQuery(v(`${mediaId}/comments`), q), {
            headers: bearer(leg),
          }),
          "{mediaId}/comments",
        ),
      browser: { workflow: "instagram-post-comments" },
    }),
    route({
      method: "GET",
      path: "/{commentId}/replies",
      summary: "Replies under a comment (`fields`, `limit`, `after`): who wrote each, and when",
      request: replies,
      api: async ({ commentId, ...q }, leg) =>
        must(
          await leg.http.json<unknown>(withQuery(v(`${commentId}/replies`), q), {
            headers: bearer(leg),
          }),
          "{commentId}/replies",
        ),
    }),
    route({
      method: "GET",
      path: "/containers/{containerId}",
      summary:
        "A media container's state (`status_code`: IN_PROGRESS, FINISHED, PUBLISHED, EXPIRED, ERROR)",
      request: containerState,
      api: async ({ containerId, fields }, leg) =>
        must(
          await leg.http.json<unknown>(withQuery(v(containerId), { fields }), {
            headers: bearer(leg),
          }),
          "{containerId}",
        ),
    }),
    route({
      method: "POST",
      path: "/{commentId}/replies",
      summary: "Reply to a comment",
      request: reply,
      irreversible: true,
      verify: {
        words: (b) => b.message,
        read: async (b, look): Promise<VerifyRead | Seen> => {
          const own = await ownAccount(look);
          if (!own?.username) return unclear("the account's username did not come back");
          const r = await look(`/${b.commentId}/replies`, {
            fields: "id,text,username,timestamp",
            limit: 100,
          });
          return {
            rows: arr(rec(r).data).map((e) => {
              const c = rec(e);
              return {
                words: text(c.text),
                at: isoOf(c.timestamp),
                id: str(c.id),
                url: null,
                mine: text(c.username).toLowerCase() === own.username?.toLowerCase(),
              };
            }),
            // Replies come in the edge's own order; only a read to the end proves absent.
            order: "ranked",
            complete: !hasNext(r),
          };
        },
      },
      sentAs: (o) => ({ id: str(rec(o).id), url: null }),
      api: async ({ commentId, message }, leg) =>
        must(
          await leg.http.json<unknown>(v(`${commentId}/replies`), {
            method: "POST",
            headers: bearer(leg),
            body: { message },
          }),
          "{commentId}/replies",
        ),
      browser: {
        workflow: "instagram-reply",
        input: (b) => ({ commentId: b.commentId, text: b.message }),
      },
    }),
    route({
      method: "POST",
      path: "/web/{username}/follow",
      summary:
        "Follow another account (`undo` unfollows): `{ username, following, already? }` or `{ found: false }`",
      request: webFollow,
      meter: () => ({ follow: 1 }),
      browser: { flow: "instagram/follow" },
    }),
    route({
      method: "POST",
      path: "/web/p/{shortcode}/like",
      summary:
        "Like another account's post (`undo` takes it back): `{ shortcode, liked, already? }`",
      request: webLike,
      meter: () => ({ like: 1 }),
      browser: { flow: "instagram/like" },
    }),
    route({
      method: "POST",
      path: "/web/p/{shortcode}/comments",
      summary:
        "Comment on another account's post (the API comments only on our own): `{ shortcode, commented }`",
      request: webComment,
      irreversible: true,
      verify: {
        words: (b) => b.text,
        read: async (b, look): Promise<VerifyRead> => {
          const r = rec(await look(`/web/p/${b.shortcode}/comments`, { max: 100 }));
          return {
            rows: arr(r.comments).map((e) => {
              const c = rec(e);
              return {
                words: text(c.text),
                at: str(c.at) ? isoOf(c.at) : null,
                id: str(c.id),
                url: null,
                // The page marks the signed-in account's comments. A reply is not a post comment.
                mine: c.mine === true && !str(c.parentId),
              };
            }),
            // Instagram ranks them; the read says when it did not reach them all.
            order: "ranked",
            complete: r.more === false && !!str(r.viewer),
          };
        },
      },
      meter: () => ({ comment: 1 }),
      browser: { flow: "instagram/comment" },
    }),
    route({
      method: "GET",
      path: "/web/p/{shortcode}",
      summary:
        "Any public post: owner `username`, caption, likes, comments, timestamp (the page's own tags)",
      request: z.object({ shortcode }),
      meter: () => ({ post: 1 }),
      browser: { flow: "instagram/post" },
    }),
    route({
      method: "GET",
      path: "/web/p/{shortcode}/comments",
      summary:
        "The comments on any public post, read off the page (the API reads only our own): `{ shortcode, url, owner, viewer, comments: [{ id, username, userId, text, at, parentId, likes, mine }], more }`, newest first; Instagram ranks them, so `more` says some were not read (`max`, default 100). Reads only",
      request: webComments,
      meter: () => ({ comments: 1 }),
      browser: { flow: "instagram/post-comments" },
    }),
    route({
      method: "GET",
      path: "/web/search",
      summary:
        "Posts for words or a #hashtag as Instagram's search shows them, top first: `{ q, shortcodes }` (`max`); read each with `GET /web/p/{shortcode}`",
      request: webSearch,
      meter: () => ({ search: 1 }),
      browser: { flow: "instagram/search" },
    }),
    route({
      method: "GET",
      path: "/web/feed",
      summary:
        "The signed-in home feed: posts by the accounts ours follows, as Instagram orders them, with caption, counts and time, in one load scrolled deep: `{ data: [{ shortcode, url, username, caption, likes, comments, timestamp }], meta: { result_count } }` (`max`, default 20). Ads and suggested posts are left. Reads only",
      request: feed,
      meter: () => ({ feed: 1 }),
      browser: { flow: "instagram/feed" },
    }),
    route({
      method: "GET",
      path: "/web/following",
      summary:
        "Every account ours follows, as the signed-in Following list pages it (the API has no follows): `{ data: [{ username, name }], meta: { result_count } }` (`max`, default 1000). Reads only",
      request: following,
      meter: () => ({ following: 1 }),
      browser: { flow: "instagram/following" },
    }),
    route({
      method: "GET",
      path: "/web/threads/following",
      summary:
        "Every account ours follows on Threads, read off the Threads profile's Following tab (Threads signs in through Instagram; its API lists no follows): `{ data: [{ username, name }], meta: { result_count, listed } }`; `listed` is the profile's own count (`max`, default 1000). Reads only",
      request: following,
      meter: () => ({ following: 1 }),
      browser: { flow: "instagram/threads-following" },
    }),
    route({
      method: "POST",
      path: "/web/profile/name",
      summary:
        "The account's display name (no API sets it; Accounts Center in the browser): `name`; answers `{ before, name }`. Twice in 14 days; the username never changes",
      request: profileName,
      irreversible: true,
      verify: { none: "a name set is idempotent: a repeat sets the same name" },
      browser: { flow: "instagram/profile-name" },
    }),
  ],
  setup: [
    {
      name: "developer-app",
      makes: ["INSTAGRAM_CLIENT_ID", "INSTAGRAM_CLIENT_SECRET"],
      how: {
        workflow: "instagram-developer-app",
        input: { redirectUri: WEB_REDIRECT },
      },
      summary:
        "On developers.facebook.com: an app with the Instagram product (Instagram Login), the redirect URI, the account as a tester; keep the Instagram app id and secret",
    },
    {
      name: "consent",
      makes: ["INSTAGRAM_ACCESS_TOKEN"],
      needs: ["INSTAGRAM_CLIENT_ID", "INSTAGRAM_CLIENT_SECRET"],
      how: { oauth: instagramOAuth },
      summary:
        "Consent once as the account; the 60-day long-lived token is kept (run again when it lapses)",
    },
  ],
};
