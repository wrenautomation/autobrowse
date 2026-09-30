/**
 * Meta under one Facebook Login app: the Marketing API (ad accounts,
 * campaigns, ad sets, creatives, ads, insights), Pages (posts, photos,
 * videos) and Instagram publishing through the Page's professional account
 * — all on graph.facebook.com with the person's user token, the Page's own
 * token fetched for Page writes. Anything that can start spending
 * (`status: ACTIVE`) is a `spends` route: the spend policy and then the
 * person say yes first, the amount being the budget on the request.
 * Written from the docs 2026-09-22; unproven until a Meta app, an ad
 * account with a payment method and a Page exist.
 */
import { z } from "zod";
import { HttpError } from "../clients/http.js";
import type { Amount } from "../gates/spend.js";
import { WEB_REDIRECT } from "./oauth.js";
import { type ApiLeg, type OAuthSpec, route, type SiteApi } from "./types.js";

export const META_ORIGIN = "https://graph.facebook.com";
/** Graph API versions live about two years. */
export const META_VERSION = "v23.0";

const bearer = (leg: ApiLeg) => ({ authorization: `Bearer ${leg.token}` });
const id = z.string().regex(/^[0-9]+$/, "a numeric Graph id");
/** An ad account id without its `act_` prefix (the path carries the prefix). */
const adAccount = z.string().regex(/^[0-9]+$/, "the ad account's number (after act_)");
const status = z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"]);
/** Graph budgets are in the account currency's minor unit: 2000 = 20.00. */
const minor = z.coerce.number().int().min(100);
const page = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().optional(),
};

const me = z.object({ fields: z.string().default("id,name") });
const adAccounts = z.object({
  fields: z.string().default("id,name,account_status,currency,amount_spent,balance"),
  ...page,
});
const pages = z.object({
  fields: z.string().default("id,name,category,instagram_business_account"),
  ...page,
});
const listIn = z.object({
  adAccountId: adAccount,
  fields: z.string().default("id,name,status,effective_status,objective,daily_budget,created_time"),
  ...page,
});
const campaign = z.object({
  adAccountId: adAccount,
  name: z.string().min(1),
  objective: z.enum([
    "OUTCOME_AWARENESS",
    "OUTCOME_TRAFFIC",
    "OUTCOME_ENGAGEMENT",
    "OUTCOME_LEADS",
    "OUTCOME_APP_PROMOTION",
    "OUTCOME_SALES",
  ]),
  status: status.default("PAUSED"),
  special_ad_categories: z.array(z.string()).default([]),
  daily_budget: minor.optional(),
  lifetime_budget: minor.optional(),
  bid_strategy: z.string().optional(),
});
const adset = z.object({
  adAccountId: adAccount,
  name: z.string().min(1),
  campaign_id: id,
  status: status.default("PAUSED"),
  daily_budget: minor.optional(),
  lifetime_budget: minor.optional(),
  billing_event: z.string().default("IMPRESSIONS"),
  optimization_goal: z.string().default("LINK_CLICKS"),
  bid_strategy: z.string().optional(),
  bid_amount: z.coerce.number().int().optional(),
  targeting: z.record(z.string(), z.unknown()),
  promoted_object: z.record(z.string(), z.unknown()).optional(),
  destination_type: z.string().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
});
const adimage = z.object({
  adAccountId: adAccount,
  url: z.string().url().optional(),
  /** Base64 of the file, when there is no public URL. */
  bytes: z.string().optional(),
  name: z.string().optional(),
});
const advideo = z.object({
  adAccountId: adAccount,
  file_url: z.string().url(),
  title: z.string().optional(),
  description: z.string().optional(),
});
const creative = z.object({
  adAccountId: adAccount,
  name: z.string().min(1),
  /** The Page post the ad shows: `{page_id, link_data|video_data}`; or `instagram_user_id` for IG placements. */
  object_story_spec: z.record(z.string(), z.unknown()),
  degrees_of_freedom_spec: z.record(z.string(), z.unknown()).optional(),
});
const ad = z.object({
  adAccountId: adAccount,
  name: z.string().min(1),
  adset_id: id,
  creative: z.object({ creative_id: id }),
  status: status.default("PAUSED"),
});
const update = z.object({
  objectId: id,
  status: status.optional(),
  name: z.string().optional(),
  daily_budget: minor.optional(),
  lifetime_budget: minor.optional(),
});
const object = z.object({ objectId: id, fields: z.string().default("id") });
const search = z.object({
  type: z.enum(["adinterest", "adgeolocation", "adworkposition", "adeducationmajor"]),
  q: z.string().min(1),
  limit: z.number().int().positive().max(100).default(25),
});
const insights = z.object({
  adAccountId: adAccount,
  fields: z.string().default("campaign_name,impressions,reach,clicks,ctr,cpc,cpm,spend,actions"),
  level: z.enum(["account", "campaign", "adset", "ad"]).default("campaign"),
  date_preset: z.string().default("last_7d"),
  time_increment: z.string().optional(),
  ...page,
});
const pagePosts = z.object({
  pageId: id,
  fields: z.string().default("id,message,created_time,permalink_url,shares,likes.summary(true)"),
  ...page,
});
const feed = z.object({
  pageId: id,
  message: z.string().min(1).max(63_206),
  link: z.string().url().optional(),
  published: z.boolean().default(true),
  scheduled_publish_time: z.coerce.number().int().optional(),
});
const photo = z.object({
  pageId: id,
  url: z.string().url(),
  message: z.string().optional(),
  published: z.boolean().default(true),
});
const video = z.object({
  pageId: id,
  file_url: z.string().url(),
  title: z.string().optional(),
  description: z.string().optional(),
});
const leadForm = z.object({
  pageId: id,
  name: z.string().min(1),
  /** Meta's question objects: `{type: "EMAIL"}`, `{type: "FULL_NAME"}`, `{type: "CUSTOM", key, label}` … */
  questions: z.array(z.record(z.string(), z.unknown())).min(1),
  privacy_policy: z.object({ url: z.string().url(), link_text: z.string().optional() }),
  /** Where the thank-you button goes. */
  follow_up_action_url: z.string().url().optional(),
  thank_you_page: z.record(z.string(), z.unknown()).optional(),
  context_card: z.record(z.string(), z.unknown()).optional(),
  locale: z.string().default("EN_US"),
});
const leadForms = z.object({
  pageId: id,
  fields: z.string().default("id,name,status,leads_count,created_time"),
  ...page,
});
const leads = z.object({
  formId: id,
  fields: z.string().default("id,created_time,ad_id,campaign_id,field_data"),
  ...page,
});
const igContainer = z.object({
  igUserId: id,
  image_url: z.string().url().optional(),
  video_url: z.string().url().optional(),
  media_type: z.enum(["IMAGE", "REELS", "STORIES", "CAROUSEL"]).optional(),
  caption: z.string().max(2200).optional(),
  children: z.array(id).optional(),
  cover_url: z.string().url().optional(),
  share_to_feed: z.boolean().optional(),
});
const igPublish = z.object({ igUserId: id, creation_id: id });
const igMedia = z.object({
  igUserId: id,
  fields: z
    .string()
    .default("id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count"),
  ...page,
});
const igInsights = z.object({
  mediaId: id,
  metric: z.string().default("reach,saved,likes,comments,shares,views"),
});
const igComments = z.object({
  mediaId: id,
  fields: z.string().default("id,text,username,timestamp,like_count"),
  ...page,
});
const igReply = z.object({ commentId: id, message: z.string().min(1).max(2200) });

async function must<T>(res: { ok: boolean; status: number; body: T | null }, what: string) {
  if (!res.ok) throw new HttpError("CALL", `${META_ORIGIN}/${what}`, res.status);
  return res.body as T;
}
const v = (path: string) => `${META_ORIGIN}/${META_VERSION}/${path}`;
const withQuery = (url: string, q: Record<string, string | number | boolean | undefined>) => {
  const u = new URL(url);
  for (const [k, val] of Object.entries(q))
    if (val !== undefined) u.searchParams.set(k, String(val));
  return u.toString();
};
const get = async (leg: ApiLeg, path: string, q: Record<string, string | number | undefined>) =>
  must(await leg.http.json<unknown>(withQuery(v(path), q), { headers: bearer(leg) }), path);
const post = async (leg: ApiLeg, path: string, body: Record<string, unknown>) =>
  must(await leg.http.json<unknown>(v(path), { method: "POST", headers: bearer(leg), body }), path);

/** A Page write needs the Page's own token: read with the user's, never kept. */
async function pageLeg(leg: ApiLeg, pageId: string): Promise<ApiLeg> {
  const got = (await get(leg, pageId, { fields: "access_token" })) as { access_token?: string };
  if (!got.access_token)
    throw new HttpError(
      "CALL",
      `${META_ORIGIN}/${pageId}`,
      403,
      "no page token: not an admin of this page",
    );
  return { ...leg, token: got.access_token };
}

/** The budget on a request, as money, when its status starts delivery. */
function budgetOf(i: {
  status?: string | undefined;
  daily_budget?: number | undefined;
  lifetime_budget?: number | undefined;
}): Amount | null | false {
  if (i.status !== "ACTIVE") return false;
  if (i.daily_budget) return { value: i.daily_budget / 100, currency: "", per: "day" };
  if (i.lifetime_budget) return { value: i.lifetime_budget / 100, currency: "" };
  return null;
}

export const metaOAuth: OAuthSpec = {
  authorizeUrl: `https://www.facebook.com/${META_VERSION}/dialog/oauth`,
  tokenUrl: `${META_ORIGIN}/${META_VERSION}/oauth/access_token`,
  scopes: [
    "ads_management",
    "ads_read",
    "business_management",
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
    "pages_manage_ads",
    "instagram_basic",
    "instagram_content_publish",
    "instagram_manage_insights",
    "instagram_manage_comments",
    "read_insights",
    "leads_retrieval",
  ],
  scopeSeparator: ",",
  clientId: "META_CLIENT_ID",
  clientSecret: "META_CLIENT_SECRET",
  // No refresh token: the long-lived user token (60 days) is kept; consent again when it lapses.
  refreshToken: "META_REFRESH_TOKEN",
  accessToken: "META_ACCESS_TOKEN",
  longLived: {
    url: `${META_ORIGIN}/${META_VERSION}/oauth/access_token`,
    fields: { grant_type: "fb_exchange_token" },
    tokenParam: "fb_exchange_token",
    clientIdParam: "client_id",
  },
  identity: { url: v("me?fields=name"), field: "name" },
  redirect: WEB_REDIRECT,
  consent: { flow: "facebook/oauth-consent" },
};

export const meta: SiteApi = {
  site: "meta",
  origin: META_ORIGIN,
  probe: { path: "/me" },
  auth: { oauth: metaOAuth },
  // The app, the Page and the ad account live on Wren's own Facebook (the default
  // account, william@): only the card on the ad account is the person's.
  routes: [
    route({
      method: "GET",
      path: "/me",
      summary: "Who the token is",
      request: me,
      api: (q, leg) => get(leg, "me", q),
    }),
    route({
      method: "GET",
      path: "/me/adaccounts",
      summary:
        "The ad accounts the person can use (`id` is `act_<number>`; routes take the number)",
      request: adAccounts,
      api: (q, leg) => get(leg, "me/adaccounts", q),
    }),
    route({
      method: "GET",
      path: "/me/accounts",
      summary: "The Pages the person admins, each with its Instagram professional account id",
      request: pages,
      api: (q, leg) => get(leg, "me/accounts", q),
    }),
    route({
      method: "GET",
      path: "/act_{adAccountId}/campaigns",
      summary: "Campaigns on an ad account (`fields`, `limit`, `after`)",
      request: listIn,
      api: ({ adAccountId, ...q }, leg) => get(leg, `act_${adAccountId}/campaigns`, q),
    }),
    route({
      method: "POST",
      path: "/act_{adAccountId}/campaigns",
      summary: "A campaign (PAUSED unless said; ACTIVE with a budget spends)",
      request: campaign,
      spends: (i) => budgetOf(i),
      api: ({ adAccountId, ...body }, leg) => post(leg, `act_${adAccountId}/campaigns`, body),
    }),
    route({
      method: "POST",
      path: "/act_{adAccountId}/adsets",
      summary: "An ad set: budget, schedule, targeting, optimization (PAUSED unless said)",
      request: adset,
      spends: (i) => budgetOf(i),
      api: ({ adAccountId, ...body }, leg) => post(leg, `act_${adAccountId}/adsets`, body),
    }),
    route({
      method: "POST",
      path: "/act_{adAccountId}/adimages",
      summary: "An ad image from a URL or base64 bytes; answers its hash for a creative",
      request: adimage,
      api: ({ adAccountId, ...body }, leg) => post(leg, `act_${adAccountId}/adimages`, body),
    }),
    route({
      method: "POST",
      path: "/act_{adAccountId}/advideos",
      summary: "An ad video from a public URL; answers its id for a creative",
      request: advideo,
      api: ({ adAccountId, ...body }, leg) => post(leg, `act_${adAccountId}/advideos`, body),
    }),
    route({
      method: "POST",
      path: "/act_{adAccountId}/adcreatives",
      summary: "A creative: the Page post the ad shows (`object_story_spec`)",
      request: creative,
      api: ({ adAccountId, ...body }, leg) => post(leg, `act_${adAccountId}/adcreatives`, body),
    }),
    route({
      method: "POST",
      path: "/act_{adAccountId}/ads",
      summary:
        "An ad: a creative in an ad set (PAUSED unless said; ACTIVE spends the set's budget)",
      request: ad,
      spends: (i) => (i.status === "ACTIVE" ? null : false),
      api: ({ adAccountId, ...body }, leg) => post(leg, `act_${adAccountId}/ads`, body),
    }),
    route({
      method: "POST",
      path: "/{objectId}",
      summary: "Update a campaign, ad set or ad: status (ACTIVE spends), name, budget",
      request: update,
      spends: (i) => budgetOf(i),
      api: ({ objectId, ...body }, leg) => post(leg, objectId, body),
    }),
    route({
      method: "GET",
      path: "/{objectId}",
      summary:
        "Any Graph object by id with `fields` (a post's `likes.summary(true),comments.summary(true),shares`)",
      request: object,
      api: ({ objectId, fields }, leg) => get(leg, objectId, { fields }),
    }),
    route({
      method: "GET",
      path: "/search",
      summary: "Targeting search: interests (`type=adinterest&q=shopify`), places, job titles",
      request: search,
      api: (q, leg) => get(leg, "search", q),
    }),
    route({
      method: "GET",
      path: "/act_{adAccountId}/insights",
      summary:
        "Results by campaign/adset/ad (`fields`, `level`, `date_preset=last_7d`, `time_increment`)",
      request: insights,
      api: ({ adAccountId, ...q }, leg) => get(leg, `act_${adAccountId}/insights`, q),
    }),
    route({
      method: "GET",
      path: "/{pageId}/posts",
      summary: "A Page's posts, newest first",
      request: pagePosts,
      api: ({ pageId, ...q }, leg) => get(leg, `${pageId}/posts`, q),
    }),
    route({
      method: "POST",
      path: "/{pageId}/feed",
      summary:
        "A text or link post on a Page (`published:false` + `scheduled_publish_time` schedules)",
      request: feed,
      irreversible: true,
      api: async ({ pageId, ...body }, leg) =>
        post(await pageLeg(leg, pageId), `${pageId}/feed`, body),
    }),
    route({
      method: "POST",
      path: "/{pageId}/photos",
      summary: "A photo post on a Page from a public image URL",
      request: photo,
      irreversible: true,
      api: async ({ pageId, ...body }, leg) =>
        post(await pageLeg(leg, pageId), `${pageId}/photos`, body),
    }),
    route({
      method: "POST",
      path: "/{pageId}/videos",
      summary: "A video (or Reel) on a Page from a public video URL",
      request: video,
      irreversible: true,
      api: async ({ pageId, ...body }, leg) =>
        post(await pageLeg(leg, pageId), `${pageId}/videos`, body),
    }),
    route({
      method: "POST",
      path: "/{pageId}/leadgen_forms",
      summary:
        "An instant form on the Page (questions + privacy policy); an ad's CTA points at its id",
      request: leadForm,
      api: async ({ pageId, ...body }, leg) =>
        post(await pageLeg(leg, pageId), `${pageId}/leadgen_forms`, body),
    }),
    route({
      method: "GET",
      path: "/{pageId}/leadgen_forms",
      summary: "The Page's instant forms with their lead counts",
      request: leadForms,
      api: async ({ pageId, ...q }, leg) =>
        get(await pageLeg(leg, pageId), `${pageId}/leadgen_forms`, q),
    }),
    route({
      method: "GET",
      path: "/{formId}/leads",
      summary:
        "Leads a form collected (`field_data` = the answers); needs leads_retrieval + the Page token",
      request: leads,
      api: async ({ formId, ...q }, leg) => {
        const form = (await get(leg, formId, { fields: "page" })) as { page?: { id?: string } };
        const pageId = form.page?.id;
        if (!pageId)
          throw new HttpError("CALL", `${META_ORIGIN}/${formId}`, 404, "no page on form");
        return get(await pageLeg(leg, pageId), `${formId}/leads`, q);
      },
    }),
    route({
      method: "POST",
      path: "/{igUserId}/media",
      summary:
        "An Instagram media container for the Page's professional account (step 1; a Reel from a public video URL)",
      request: igContainer,
      api: ({ igUserId, ...body }, leg) => post(leg, `${igUserId}/media`, body),
    }),
    route({
      method: "POST",
      path: "/{igUserId}/media_publish",
      summary: "Publish an Instagram container (step 2); answers the media id",
      request: igPublish,
      irreversible: true,
      api: ({ igUserId, creation_id }, leg) =>
        post(leg, `${igUserId}/media_publish`, { creation_id }),
    }),
    route({
      method: "GET",
      path: "/{igUserId}/media",
      summary: "The Instagram account's posts, newest first",
      request: igMedia,
      api: ({ igUserId, ...q }, leg) => get(leg, `${igUserId}/media`, q),
    }),
    route({
      method: "GET",
      path: "/{mediaId}/insights",
      summary: "An Instagram post's metrics (`metric=reach,saved,likes,comments,shares,views`)",
      request: igInsights,
      api: ({ mediaId, metric }, leg) => get(leg, `${mediaId}/insights`, { metric }),
    }),
    route({
      method: "GET",
      path: "/{mediaId}/comments",
      summary: "Comments on an Instagram post",
      request: igComments,
      api: ({ mediaId, ...q }, leg) => get(leg, `${mediaId}/comments`, q),
    }),
    route({
      method: "POST",
      path: "/{commentId}/replies",
      summary: "Reply to an Instagram comment",
      request: igReply,
      irreversible: true,
      api: ({ commentId, message }, leg) => post(leg, `${commentId}/replies`, { message }),
    }),
  ],
  setup: [
    {
      name: "developer-app",
      makes: ["META_CLIENT_ID", "META_CLIENT_SECRET"],
      how: {
        workflow: "meta-developer-app",
        input: { redirectUri: WEB_REDIRECT },
      },
      summary:
        "On developers.facebook.com: a Business app with Facebook Login for Business, Marketing API and Instagram products, the redirect URI; keep the app id and secret",
    },
    {
      name: "consent",
      makes: ["META_ACCESS_TOKEN"],
      needs: ["META_CLIENT_ID", "META_CLIENT_SECRET"],
      how: { oauth: metaOAuth },
      summary:
        "Consent once as the person who admins the Page and the ad account; the 60-day long-lived token is kept (run again when it lapses)",
    },
  ],
};
