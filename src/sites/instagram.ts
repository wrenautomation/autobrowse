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
import { HttpError } from "../clients/http.js";
import { type ApiLeg, type OAuthSpec, route, type SiteApi } from "./types.js";

export const INSTAGRAM_ORIGIN = "https://graph.instagram.com";
/** Graph API versions live about two years. */
export const INSTAGRAM_VERSION = "v23.0";

const bearer = (leg: ApiLeg) => ({ authorization: `Bearer ${leg.token}` });
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
const webPost = z.object({
  caption: z.string().max(2200).default(""),
  /** A local image or video file the browser leg uploads. */
  file: z.string().min(1),
});

async function must<T>(res: { ok: boolean; status: number; body: T | null }, what: string) {
  if (!res.ok) throw new HttpError("CALL", `${INSTAGRAM_ORIGIN}/${what}`, res.status);
  return res.body as T;
}
const v = (path: string) => `${INSTAGRAM_ORIGIN}/${INSTAGRAM_VERSION}/${path}`;
const withQuery = (url: string, q: Record<string, string | number | undefined>) => {
  const u = new URL(url);
  for (const [k, val] of Object.entries(q))
    if (val !== undefined) u.searchParams.set(k, String(val));
  return u.toString();
};

export const instagramOAuth: OAuthSpec = {
  authorizeUrl: "https://www.instagram.com/oauth/authorize",
  tokenUrl: "https://api.instagram.com/oauth/access_token",
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
  auth: { oauth: instagramOAuth },
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
      browser: { workflow: "instagram-create-post" },
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
      method: "POST",
      path: "/{commentId}/replies",
      summary: "Reply to a comment",
      request: reply,
      irreversible: true,
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
  ],
  setup: [
    {
      name: "developer-app",
      makes: ["INSTAGRAM_CLIENT_ID", "INSTAGRAM_CLIENT_SECRET"],
      how: {
        workflow: "instagram-developer-app",
        input: { redirectUri: "http://127.0.0.1:9400/oauth/callback" },
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
