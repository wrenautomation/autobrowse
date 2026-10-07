/**
 * LinkedIn under its own API's shape (Posts API, Social Actions, OIDC
 * userinfo). Posting on the member's own behalf is self-serve ("Share on
 * LinkedIn", `w_member_social`); reading reactions and comments is
 * partner-gated, so those routes answer through browser flows until the
 * app is approved. Headers and paths follow api.linkedin.com; the browser
 * legs answer in the same shape.
 */
import { z } from "zod";
import { WREN_PAGE } from "../browser/flows/linkedin-audience.js";
import { HttpError } from "../clients/http.js";
import {
  type ApiLeg,
  type OAuthSpec,
  route,
  type SiteApi,
  SiteError,
  type SiteRoute,
} from "./types.js";

export const LINKEDIN_ORIGIN = "https://api.linkedin.com";
/** LinkedIn versions its REST API by month; a version is honoured for a year. */
export const LINKEDIN_VERSION = "202508";
/**
 * Pages Wren's account admins, by numeric id. The API says who posts with an
 * author URN; the browser leg reads the Page's name live and picks it off the
 * composer's author list, so a rename needs no change here.
 */
export const LINKEDIN_PAGES: ReadonlySet<string> = new Set([WREN_PAGE]);

const PAGE_URN = /^urn:li:organization:(\d+)$/;

/**
 * The Page id an author URN posts as, or none for the member.
 * Wren's token holds `w_member_social` only, so a Page's post goes by the browser.
 */
export function composerPage(author: string): string | undefined {
  const id = PAGE_URN.exec(author)?.[1];
  if (!id) return undefined;
  if (!LINKEDIN_PAGES.has(id))
    throw new SiteError(400, `${author} is not a Page Wren admins: add it to LINKEDIN_PAGES`);
  return id;
}

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
const flag = z.preprocess((v) => v === true || v === "true", z.boolean()).default(false);
const inbox = z.object({
  max: z.coerce.number().int().min(1).max(100).default(20),
  unread: flag,
});
const profile = z.object({
  vanity,
  experience: flag,
  company: flag,
  prefer: z.string().max(300).optional(),
});
const handle = z
  .string()
  .regex(/^[A-Za-z0-9_%-]{2,100}$/, "a company handle or id (the part after /company/)");
const companyPeople = z.object({
  company: handle,
  keywords: z.string().optional(),
  max: z.coerce.number().int().min(1).max(200).default(30),
});
const companyJobs = z.object({
  company: handle,
  location: z.string().min(2).max(100).optional(),
  max: z.coerce.number().int().min(1).max(200).default(50),
});
const connect = z.object({ vanity, note: z.string().min(1).max(200).optional() });
const message = z.object({ vanity, text: z.string().min(1).max(8000) });
/** A list read from the top, newest first. */
const newest = z.object({ max: z.coerce.number().int().min(1).max(200).default(40) });
const activity = z.object({
  vanity,
  max: z.coerce.number().int().min(1).max(100).default(20),
});
const postsMax = z.coerce.number().int().min(1).max(50).default(20);
const searchPosts = z.object({
  keywords: z.string().min(1).max(200),
  max: postsMax,
  since: z.enum(["past-24h", "past-week", "past-month"]).default("past-week"),
});
const companyPosts = z.object({ company: handle, max: postsMax });

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

/**
 * Every metered call also spends its size in `total`: one account's whole day across kinds. Only
 * an account whose caps name `total` is held to it (the personal one: 20, 2026-10-07).
 */
function withTotal(r: SiteRoute<never, unknown>): SiteRoute<never, unknown> {
  const meter = r.meter;
  if (!meter) return r;
  return {
    ...r,
    meter: (q) => {
      const use = meter(q);
      return { ...use, total: Object.values(use).reduce((n, k) => n + k, 0) };
    },
  };
}

export const linkedin: SiteApi = {
  site: "linkedin",
  origin: LINKEDIN_ORIGIN,
  probe: { path: "/v2/userinfo" },
  auth: { oauth: linkedinOAuth },
  // Reads a person could do in a day without LinkedIn restricting the account, per account.
  // Invites and messages at a person's pace: LinkedIn's own weekly invite limit is ~100, and an
  // account that sends more than a few dozen a day is the one it restricts. Outreach ramps
  // under these (wren's reach loop), never at them.
  caps: {
    profile: 80,
    search: 25,
    company: 40,
    connect: 20,
    message: 25,
    inbox: 48,
    network: 12,
    withdraw: 20,
    notifications: 12,
    // A member's activity page: off (linkedin, linkedin@wren) unless an account's own caps open it.
    activity: 0,
    // Our own audience (profile + Page, two page loads): on demand from wren, never on a timer.
    audience: 4,
    // Posts by others to comment on (search, a company's Posts tab): reads run only as linkedin@wren.
    posts: 12,
  },
  // William's own profile (shown as "Will Jin"): research reads since 2026-10-06, when the alt was
  // restricted ("just use my main ... unless alt still works"); the alt's pace, nothing sent, never
  // anything that ties it to Wren. Before: all 0 from 2026-10-01 (ban risk).
  accountCaps: {
    linkedin: {
      profile: 20,
      search: 5,
      company: 10,
      connect: 0,
      message: 0,
      inbox: 0,
      network: 0,
      withdraw: 0,
      notifications: 0,
      audience: 0,
      activity: 10,
      posts: 0,
      // Research reads in all, search first in wren (designs 2026-10-07-linkedin-search-first): 20 a day.
      total: 20,
    },
    // The research alt (2026-10-05): reads only. LinkedIn restricted it 2026-10-06 (asks for an ID).
    "linkedin@alt": {
      profile: 20,
      search: 5,
      company: 10,
      connect: 0,
      message: 0,
      inbox: 0,
      network: 0,
      withdraw: 0,
      notifications: 0,
      audience: 0,
      // wren's signals (designs 2026-10-06-signal-collectors, S5): 10 people a day.
      activity: 10,
      posts: 0,
      total: 20,
    },
  },
  pace: { gapMs: 10_000, jitterMs: 20_000 },
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
      summary:
        "Publish a post as the member, or as a Page it admins (`author: urn:li:organization:…`, by the browser)",
      request: post,
      irreversible: true,
      // The token posts only as its member (no w_organization_social): a Page's post is the composer's.
      prefer: (b) => (composerPage(b.author) ? "browser" : undefined),
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
        input: (b) => ({
          text: b.commentary,
          visibility: b.visibility,
          page: composerPage(b.author),
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
      meter: (q) => ({ search: q.pages }),
      browser: { flow: "linkedin/search-people" },
    }),
    route({
      method: "GET",
      path: "/in/{vanity}",
      summary:
        "One profile: headline, location, about; `experience=true` adds every role, `company=true` also the current employer's page (website, size)",
      request: profile,
      meter: (q) => ({ profile: 1, ...(q.company ? { company: 1 } : {}) }),
      browser: { flow: "linkedin/profile" },
    }),
    route({
      method: "GET",
      path: "/company/{company}",
      summary: "A company's About page: website, phone, industry, size, headquarters, founded",
      request: z.object({ company: handle }),
      meter: () => ({ company: 1 }),
      browser: { flow: "linkedin/company" },
    }),
    route({
      method: "GET",
      path: "/company/{company}/jobs",
      summary:
        "A company's open roles, worldwide: title, location, posted date, URL (`max`, default 50)",
      request: companyJobs,
      meter: () => ({ company: 1 }),
      browser: { flow: "linkedin/company-jobs" },
    }),
    route({
      method: "GET",
      path: "/company/{company}/people",
      summary: "A company's people (`keywords` narrows: founder, partner; `max`, default 30)",
      request: companyPeople,
      meter: () => ({ company: 1 }),
      browser: { flow: "linkedin/company-people" },
    }),
    route({
      method: "POST",
      path: "/in/{vanity}/connect",
      summary: "Invite to connect, with an optional note (200 characters; five notes a month free)",
      request: connect,
      irreversible: true,
      meter: () => ({ connect: 1 }),
      browser: { flow: "linkedin/connect" },
    }),
    route({
      method: "GET",
      path: "/in/{vanity}/activity",
      summary:
        "A member's posts, reposts and comments, newest first (`max`, default 20): urn, kind, text, age label and approximate time, reactions, comments, url, raw. Reads only",
      request: activity,
      meter: () => ({ activity: 1 }),
      browser: { flow: "linkedin/activity" },
    }),
    route({
      method: "GET",
      path: "/search/results/content",
      summary:
        "Posts for a keyword, newest first (`keywords`, `max` default 20, `since` past-24h|past-week|past-month): urn, author, authorUrl, headline, text, age, reactions, comments, url, raw; `dropped` counts cards with no post urn. Reads only",
      request: searchPosts,
      meter: () => ({ posts: 1 }),
      browser: { flow: "linkedin/search-posts" },
    }),
    route({
      method: "GET",
      path: "/company/{company}/posts",
      summary:
        "A company's recent posts (`max`, default 20), in the search's shape: posts and dropped. Reads only",
      request: companyPosts,
      meter: () => ({ posts: 1 }),
      browser: { flow: "linkedin/company-posts" },
    }),
    route({
      method: "GET",
      path: "/in/{vanity}/relationship",
      summary:
        "Where this account stands with a member: connected (1st), pending (our invite is out), none",
      request: z.object({ vanity }),
      meter: () => ({ profile: 1 }),
      browser: { flow: "linkedin/relationship" },
    }),
    route({
      method: "POST",
      path: "/in/{vanity}/withdraw",
      summary:
        "Withdraw our pending invite (reads the button first: connected or none withdraws nothing and says so)",
      request: z.object({ vanity }),
      irreversible: true,
      meter: () => ({ withdraw: 1 }),
      browser: { flow: "linkedin/withdraw" },
    }),
    route({
      method: "GET",
      path: "/connections",
      summary:
        "Recently added connections, newest first (`max`, default 40): name, handle, headline, when they connected",
      request: newest,
      meter: () => ({ network: 1 }),
      browser: { flow: "linkedin/connections" },
    }),
    route({
      method: "GET",
      path: "/notifications",
      summary:
        "The notifications page, newest first (`max`, default 40): id, kind, actor, text, url, approximate time, raw. Reads only",
      request: newest,
      meter: () => ({ notifications: 1 }),
      browser: { flow: "linkedin/notifications" },
    }),
    route({
      method: "GET",
      path: "/audience",
      summary:
        "The account's own followers and connections, and a Page's followers (`page`: handle or id, default Wren's; empty skips it), with the text each came from. Reads only",
      request: z.object({ page: z.union([handle, z.literal("")]).optional() }),
      meter: () => ({ audience: 1 }),
      browser: { flow: "linkedin/audience" },
    }),
    route({
      method: "GET",
      path: "/messaging",
      summary:
        "The inbox's conversations newest first (`max`, `unread=true`): name, handle, preview, unread",
      request: inbox,
      meter: () => ({ inbox: 1 }),
      browser: { flow: "linkedin/inbox" },
    }),
    route({
      method: "POST",
      path: "/in/{vanity}/message",
      summary: "Message a 1st-degree connection (anyone else is InMail, which needs Premium)",
      request: message,
      irreversible: true,
      meter: () => ({ message: 1 }),
      browser: { flow: "linkedin/message" },
    }),
  ].map(withTotal),
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
