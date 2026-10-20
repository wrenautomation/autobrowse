/**
 * Threads under its own Graph API (graph.threads.net). The profile rides on
 * an Instagram account, so consent signs in through Instagram. Publishing is
 * two calls, like Instagram: a container (text, an image or a video by
 * public URL, or a carousel of containers), then publish. Insights and
 * replies are covered. Written from the docs 2026-10-13: the app is "Wren
 * Threads" (Threads use case), the account @wrenautomation is its tester.
 */
import { z } from "zod";
import { HttpError } from "../clients/http.js";
import { OAUTH_PROVIDERS } from "../oauth/providers.js";
import { graphWhy } from "./meta.js";
import { WEB_REDIRECT } from "./oauth.js";
import { type ApiLeg, type OAuthSpec, route, type SiteApi } from "./types.js";
import type { Seen } from "./verdict.js";
import { rec, str, text, unclear } from "./verify-kit.js";

export const THREADS_ORIGIN = "https://graph.threads.net";
export const THREADS_VERSION = "v1.0";
/** A post's text cap, in characters. */
export const THREADS_MAX = 500;

const bearer = (leg: ApiLeg) => ({ authorization: `Bearer ${leg.token}` });
const id = z.string().regex(/^[0-9]+$/, "a numeric Threads id");
/** "me" stands for the token's own profile wherever a user id goes. */
const user = z.union([id, z.literal("me")]);

const me = z.object({
  fields: z.string().default("id,username,name,threads_profile_picture_url"),
});
const container = z.object({
  userId: user,
  media_type: z.enum(["TEXT", "IMAGE", "VIDEO", "CAROUSEL"]),
  text: z.string().max(THREADS_MAX).optional(),
  image_url: z.string().url().optional(),
  video_url: z.string().url().optional(),
  children: z.array(id).min(2).max(20).optional(),
  is_carousel_item: z.boolean().optional(),
  /** Answer under another post (the reply's parent). */
  reply_to_id: id.optional(),
  reply_control: z.enum(["everyone", "accounts_you_follow", "mentioned_only"]).optional(),
  /** A link attachment shown as a card on a text post. */
  link_attachment: z.string().url().optional(),
});
const publish = z.object({ userId: user, creation_id: id });
const status = z.object({
  containerId: id,
  fields: z.string().default("id,status,error_message"),
});
const post = z.object({
  mediaId: id,
  fields: z.string().default("id,permalink,text,media_type,timestamp,shortcode"),
});
const listPosts = z.object({
  userId: user,
  fields: z.string().default("id,permalink,text,media_type,timestamp"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().optional(),
});
const insights = z.object({
  mediaId: id,
  metric: z.string().default("views,likes,replies,reposts,quotes,shares"),
});
const replies = z.object({
  mediaId: id,
  fields: z.string().default("id,text,username,permalink,timestamp"),
  reverse: z.boolean().default(true),
});

async function must<T>(res: { ok: boolean; status: number; body: T | null }, what: string) {
  if (!res.ok)
    throw new HttpError("CALL", `${THREADS_ORIGIN}/${what}`, res.status, graphWhy(res.body));
  return res.body as T;
}
const v = (path: string) => `${THREADS_ORIGIN}/${THREADS_VERSION}/${path}`;
const withQuery = (url: string, q: Record<string, string | number | boolean | undefined>) => {
  const u = new URL(url);
  for (const [k, val] of Object.entries(q))
    if (val !== undefined) u.searchParams.set(k, String(val));
  return u.toString();
};

export const threadsOAuth: OAuthSpec = {
  authorizeUrl: OAUTH_PROVIDERS.threads.authorize,
  tokenUrl: OAUTH_PROVIDERS.threads.token,
  scopes: [
    "threads_basic",
    "threads_content_publish",
    "threads_manage_insights",
    "threads_manage_replies",
    "threads_read_replies",
    "threads_keyword_search",
    "threads_manage_mentions",
    "threads_profile_discovery",
  ],
  scopeSeparator: ",",
  clientId: "THREADS_CLIENT_ID",
  clientSecret: "THREADS_CLIENT_SECRET",
  // No refresh token: the long-lived token (60 days) is kept; consent again when it lapses.
  refreshToken: "THREADS_REFRESH_TOKEN",
  accessToken: "THREADS_ACCESS_TOKEN",
  // Meta takes neither http nor localhost: the app's https redirect, answered by the browser.
  redirect: WEB_REDIRECT,
  longLived: {
    url: `${THREADS_ORIGIN}/access_token`,
    fields: { grant_type: "th_exchange_token" },
    tokenParam: "access_token",
  },
  identity: { url: v("me?fields=username"), field: "username" },
  // The authorize page signs in with Instagram, so the walk runs in the Instagram profile.
  consent: { flow: "instagram/threads-consent" },
};

export const threads: SiteApi = {
  site: "threads",
  origin: THREADS_ORIGIN,
  probe: { path: "/me" },
  auth: { oauth: threadsOAuth },
  // 250 posts and 1,000 replies a profile a day (Threads' own caps).
  caps: { post: 250, reply: 1000 },
  routes: [
    route({
      method: "GET",
      path: "/me",
      summary: "Who the token is: `id` is the user id the other routes take (or say `me`)",
      request: me,
      api: async ({ fields }, leg) =>
        must(
          await leg.http.json<unknown>(withQuery(v("me"), { fields }), { headers: bearer(leg) }),
          "me",
        ),
    }),
    route({
      method: "POST",
      path: "/{userId}/threads",
      summary:
        "A container (step 1): TEXT, IMAGE or VIDEO by public URL, or CAROUSEL of item containers; `reply_to_id` makes it a reply. Answers its id",
      request: container,
      meter: (i) => (i.reply_to_id ? { reply: 1 } : i.is_carousel_item ? {} : { post: 1 }),
      api: async ({ userId, ...body }, leg) =>
        must(
          await leg.http.json<unknown>(v(`${userId}/threads`), {
            method: "POST",
            headers: bearer(leg),
            body,
          }),
          `${userId}/threads`,
        ),
    }),
    route({
      method: "GET",
      path: "/containers/{containerId}",
      summary: "A container's state before publish (`status`: IN_PROGRESS, FINISHED, ERROR)",
      request: status,
      api: async ({ containerId, fields }, leg) =>
        must(
          await leg.http.json<unknown>(withQuery(v(containerId), { fields }), {
            headers: bearer(leg),
          }),
          containerId,
        ),
    }),
    route({
      method: "POST",
      path: "/{userId}/threads_publish",
      summary: "Publish a container (step 2); answers the post id",
      request: publish,
      irreversible: true,
      verify: {
        // The container says whether it was published: a state, not words.
        words: () => "",
        read: async (b, look): Promise<Seen> => {
          const status = text(
            rec(await look(`/containers/${b.creation_id}`, { fields: "id,status" })).status,
          );
          if (status === "PUBLISHED") return { seen: "found", id: null, url: null, at: null };
          // Never published, and never will be: its time is out or it failed.
          if (status === "ERROR" || status === "EXPIRED") return { seen: "absent" };
          // Ready or still processing: the publish may yet land.
          return unclear(`the container is ${status || "in an unknown state"}`);
        },
      },
      sentAs: (o) => ({ id: str(rec(o).id), url: null }),
      api: async ({ userId, creation_id }, leg) =>
        must(
          await leg.http.json<unknown>(v(`${userId}/threads_publish`), {
            method: "POST",
            headers: bearer(leg),
            body: { creation_id },
          }),
          `${userId}/threads_publish`,
        ),
    }),
    route({
      method: "GET",
      path: "/posts/{mediaId}",
      summary: "One post: its permalink, text, type and time",
      request: post,
      api: async ({ mediaId, fields }, leg) =>
        must(
          await leg.http.json<unknown>(withQuery(v(mediaId), { fields }), {
            headers: bearer(leg),
          }),
          mediaId,
        ),
    }),
    route({
      method: "GET",
      path: "/{userId}/threads",
      summary: "The profile's posts, newest first (`fields`, `limit`, `after` cursor)",
      request: listPosts,
      api: async ({ userId, fields, limit, after }, leg) =>
        must(
          await leg.http.json<unknown>(
            withQuery(v(`${userId}/threads`), { fields, limit, after }),
            { headers: bearer(leg) },
          ),
          `${userId}/threads`,
        ),
    }),
    route({
      method: "GET",
      path: "/{mediaId}/insights",
      summary: "A post's metrics (`metric=views,likes,replies,reposts,quotes,shares`)",
      request: insights,
      api: async ({ mediaId, metric }, leg) =>
        must(
          await leg.http.json<unknown>(withQuery(v(`${mediaId}/insights`), { metric }), {
            headers: bearer(leg),
          }),
          `${mediaId}/insights`,
        ),
    }),
    route({
      method: "GET",
      path: "/{mediaId}/replies",
      summary: "Replies under a post, oldest first unless `reverse` is false",
      request: replies,
      api: async ({ mediaId, fields, reverse }, leg) =>
        must(
          await leg.http.json<unknown>(withQuery(v(`${mediaId}/replies`), { fields, reverse }), {
            headers: bearer(leg),
          }),
          `${mediaId}/replies`,
        ),
    }),
  ],
  setup: [
    {
      name: "developer-app",
      makes: ["THREADS_CLIENT_ID", "THREADS_CLIENT_SECRET"],
      how: { workflow: "threads-developer-app", input: { redirectUri: WEB_REDIRECT } },
      summary:
        "On developers.facebook.com: an app with the Threads use case, its permissions, the redirect URI, the profile as a Threads tester (accepted in Threads settings); keep the Threads app id and secret",
    },
    {
      name: "consent",
      makes: ["THREADS_ACCESS_TOKEN"],
      needs: ["THREADS_CLIENT_ID", "THREADS_CLIENT_SECRET"],
      how: { oauth: threadsOAuth },
      summary:
        "Consent once as the profile (through Instagram); the 60-day long-lived token is kept (run again when it lapses)",
    },
  ],
};
