/**
 * LinkedIn under its own API's shape (Posts API, Social Actions, OIDC
 * userinfo). Posting on the member's own behalf is self-serve ("Share on
 * LinkedIn", `w_member_social`); reading reactions and comments is
 * partner-gated, so those routes answer through browser flows until the
 * app is approved. Headers and paths follow api.linkedin.com; the browser
 * legs answer in the same shape.
 */
import { z } from "zod";
import { HttpError } from "../clients/http.js";
import { type ApiLeg, type OAuthSpec, route, type SiteApi } from "./types.js";

export const LINKEDIN_ORIGIN = "https://api.linkedin.com";
/** LinkedIn versions its REST API by month; a version is honoured for a year. */
export const LINKEDIN_VERSION = "202508";
/**
 * Who the composer posts as, by the name it lists (the member, or a Page
 * this account admins). The API says it with an author URN; the browser
 * leg can only read names off the author list.
 */
export const LINKEDIN_AUTHOR = "LINKEDIN_AUTHOR";

const headers = (leg: ApiLeg, version = LINKEDIN_VERSION) => ({
  authorization: `Bearer ${leg.token}`,
  "LinkedIn-Version": version,
  "X-Restli-Protocol-Version": "2.0.0",
});

const urn = z.string().regex(/^urn:li:[a-zA-Z]+:[A-Za-z0-9_-]+$/, "a LinkedIn URN");

const post = z.object({
  author: urn,
  commentary: z.string().min(1).max(3000),
  visibility: z.enum(["PUBLIC", "CONNECTIONS", "LOGGED_IN"]).default("PUBLIC"),
  distribution: z
    .object({
      feedDistribution: z.enum(["MAIN_FEED", "NONE"]).default("MAIN_FEED"),
      targetEntities: z.array(z.unknown()).default([]),
      thirdPartyDistributionChannels: z.array(z.unknown()).default([]),
    })
    .default({
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    }),
  lifecycleState: z.enum(["PUBLISHED", "DRAFT"]).default("PUBLISHED"),
  isReshareDisabledByAuthor: z.boolean().default(false),
  content: z
    .object({
      media: z.object({ id: urn, title: z.string().optional(), altText: z.string().optional() }),
    })
    .optional(),
});
export type LinkedInPost = z.infer<typeof post>;

const listPosts = z.object({
  q: z.literal("author").default("author"),
  author: urn,
  count: z.coerce.number().int().min(1).max(100).default(10),
  start: z.coerce.number().int().min(0).default(0),
  sortBy: z.enum(["LAST_MODIFIED", "CREATED"]).default("LAST_MODIFIED"),
});
const byUrn = z.object({ urn });
const comment = z.object({
  urn,
  actor: urn,
  message: z.object({ text: z.string().min(1).max(1250) }),
});
const comments = z.object({
  urn,
  count: z.coerce.number().int().min(1).max(100).default(10),
  start: z.coerce.number().int().min(0).default(0),
});
const initUpload = z.object({
  action: z.literal("initializeUpload").default("initializeUpload"),
  initializeUploadRequest: z.object({ owner: urn }),
});

const vanity = z
  .string()
  .regex(/^[A-Za-z0-9_%-]{2,100}$/, "a profile handle (the part after /in/)");
const peopleSearch = z.object({
  keywords: z.string().min(1),
  page: z.coerce.number().int().min(1).max(100).default(1),
  pages: z.coerce.number().int().min(1).max(10).default(1),
  network: z
    .preprocess((v) => (typeof v === "string" ? v.split(",") : v), z.array(z.enum(["F", "S", "O"])))
    .optional(),
});
const profile = z.object({
  vanity,
  experience: z.preprocess((v) => v === true || v === "true", z.boolean()).default(false),
});
const companyPeople = z.object({
  company: z
    .string()
    .regex(/^[A-Za-z0-9_%-]{2,100}$/, "a company handle (the part after /company/)"),
  keywords: z.string().optional(),
  max: z.coerce.number().int().min(1).max(200).default(30),
});
const connect = z.object({ vanity, note: z.string().min(1).max(200).optional() });
const message = z.object({ vanity, text: z.string().min(1).max(8000) });

async function must<T>(res: { ok: boolean; status: number; body: T | null }, what: string) {
  if (!res.ok) throw new HttpError("CALL", `${LINKEDIN_ORIGIN}/${what}`, res.status);
  return res.body as T;
}

export const linkedinOAuth: OAuthSpec = {
  authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
  tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
  scopes: ["openid", "profile", "email", "w_member_social"],
  clientId: "LINKEDIN_CLIENT_ID",
  clientSecret: "LINKEDIN_CLIENT_SECRET",
  refreshToken: "LINKEDIN_REFRESH_TOKEN",
  accessToken: "LINKEDIN_ACCESS_TOKEN",
  consent: { flow: "linkedin/oauth-consent" },
};

export const linkedin: SiteApi = {
  site: "linkedin",
  origin: LINKEDIN_ORIGIN,
  probe: { path: "/v2/userinfo" },
  auth: { oauth: linkedinOAuth },
  routes: [
    route({
      method: "GET",
      path: "/v2/userinfo",
      summary: "Who the token is: `sub` makes the author URN `urn:li:person:{sub}`",
      request: z.object({}),
      api: async (_i, leg) =>
        must(
          await leg.http.json<{ sub: string; name?: string; email?: string }>(
            `${LINKEDIN_ORIGIN}/v2/userinfo`,
            { headers: { authorization: `Bearer ${leg.token}` } },
          ),
          "v2/userinfo",
        ),
      browser: { workflow: "linkedin-whoami" },
    }),
    route({
      method: "POST",
      path: "/rest/posts",
      summary: "Publish a post as the member (text, or text + an uploaded image/video)",
      request: post,
      irreversible: true,
      api: async (body, leg) => {
        const res = await leg.http.json<unknown>(`${LINKEDIN_ORIGIN}/rest/posts`, {
          method: "POST",
          headers: headers(leg),
          body,
        });
        await must(res, "rest/posts");
        // The API answers 201 with the new URN in a header; the body carries it here.
        return { id: res.headers.get("x-restli-id") ?? "" };
      },
      browser: {
        flow: "linkedin/create-post",
        input: (b, env) => ({
          text: b.commentary,
          visibility: b.visibility,
          author: env(LINKEDIN_AUTHOR),
        }),
      },
    }),
    route({
      method: "GET",
      path: "/rest/posts",
      summary: "The member's posts, newest first (`q=author&author=urn:li:person:…&count&start`)",
      request: listPosts,
      api: async (q, leg) => {
        const u = new URL(`${LINKEDIN_ORIGIN}/rest/posts`);
        u.searchParams.set("q", "author");
        u.searchParams.set("author", q.author);
        u.searchParams.set("count", String(q.count));
        u.searchParams.set("start", String(q.start));
        u.searchParams.set("sortBy", q.sortBy);
        return must(
          await leg.http.json<unknown>(u.toString(), { headers: headers(leg) }),
          "rest/posts",
        );
      },
      browser: {
        workflow: "linkedin-list-posts",
        input: (q) => ({ count: q.count, start: q.start }),
      },
    }),
    route({
      method: "GET",
      path: "/rest/posts/{urn}",
      summary: "One post",
      request: byUrn,
      api: async ({ urn }, leg) =>
        must(
          await leg.http.json<unknown>(`${LINKEDIN_ORIGIN}/rest/posts/${encodeURIComponent(urn)}`, {
            headers: headers(leg),
          }),
          "rest/posts/{urn}",
        ),
    }),
    route({
      method: "GET",
      path: "/rest/socialActions/{urn}",
      summary: "Reaction and comment counts for a post (API leg needs Community Management access)",
      request: byUrn,
      api: async ({ urn }, leg) =>
        must(
          await leg.http.json<unknown>(
            `${LINKEDIN_ORIGIN}/rest/socialActions/${encodeURIComponent(urn)}`,
            { headers: headers(leg) },
          ),
          "rest/socialActions/{urn}",
        ),
      browser: { workflow: "linkedin-post-stats" },
    }),
    route({
      method: "GET",
      path: "/rest/socialActions/{urn}/comments",
      summary: "Comments on a post (`count&start`)",
      request: comments,
      api: async ({ urn, count, start }, leg) =>
        must(
          await leg.http.json<unknown>(
            `${LINKEDIN_ORIGIN}/rest/socialActions/${encodeURIComponent(urn)}/comments?count=${count}&start=${start}`,
            { headers: headers(leg) },
          ),
          "rest/socialActions/{urn}/comments",
        ),
      browser: { workflow: "linkedin-post-comments" },
    }),
    route({
      method: "POST",
      path: "/rest/socialActions/{urn}/comments",
      summary: "Comment on a post (or reply, when `urn` is a comment)",
      request: comment,
      irreversible: true,
      api: async ({ urn, ...body }, leg) =>
        must(
          await leg.http.json<unknown>(
            `${LINKEDIN_ORIGIN}/rest/socialActions/${encodeURIComponent(urn)}/comments`,
            { method: "POST", headers: headers(leg), body },
          ),
          "rest/socialActions/{urn}/comments",
        ),
      browser: {
        workflow: "linkedin-comment",
        input: (b) => ({ urn: b.urn, text: b.message.text }),
      },
    }),
    route({
      method: "POST",
      path: "/rest/images",
      summary:
        "Start an image upload: answers `uploadUrl` (PUT the bytes there) and the image URN for a post",
      request: initUpload,
      api: async (body, leg) =>
        must(
          await leg.http.json<unknown>(`${LINKEDIN_ORIGIN}/rest/images?action=initializeUpload`, {
            method: "POST",
            headers: headers(leg),
            body: { initializeUploadRequest: body.initializeUploadRequest },
          }),
          "rest/images",
        ),
    }),
    // No API sells these to anyone but partners: the paths are linkedin.com's own pages.
    route({
      method: "GET",
      path: "/search/results/people",
      summary:
        "People search (`keywords`, `page`, `pages`, `network` F/S/O): name, headline, location, the role that matched, profile handle",
      request: peopleSearch,
      browser: { flow: "linkedin/search-people" },
    }),
    route({
      method: "GET",
      path: "/in/{vanity}",
      summary: "One profile: headline, location, about; `experience=true` adds every role as text",
      request: profile,
      browser: { flow: "linkedin/profile" },
    }),
    route({
      method: "GET",
      path: "/company/{company}/people",
      summary: "A company's people (`keywords` narrows: founder, partner; `max`, default 30)",
      request: companyPeople,
      browser: { flow: "linkedin/company-people" },
    }),
    route({
      method: "POST",
      path: "/in/{vanity}/connect",
      summary: "Invite to connect, with an optional note (200 characters; five notes a month free)",
      request: connect,
      irreversible: true,
      browser: { flow: "linkedin/connect" },
    }),
    route({
      method: "POST",
      path: "/in/{vanity}/message",
      summary: "Message a 1st-degree connection (anyone else is InMail, which needs Premium)",
      request: message,
      irreversible: true,
      browser: { flow: "linkedin/message" },
    }),
  ],
  setup: [
    {
      name: "developer-app",
      makes: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
      how: {
        workflow: "linkedin-developer-app",
        input: { redirectUri: "http://127.0.0.1:9400/oauth/callback" },
      },
      summary:
        "Create the developer app on linkedin.com/developers (needs a Page), add Share on LinkedIn + Sign In with OpenID Connect, keep the client id and secret",
    },
    {
      name: "consent",
      makes: ["LINKEDIN_ACCESS_TOKEN"],
      needs: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
      how: { oauth: linkedinOAuth },
      summary:
        "Consent once as the member; the 60-day access token is kept with its lapse date and made again 14 days before (`site renew`, daily on the box)",
    },
  ],
};
