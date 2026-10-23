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
import { POST_URN } from "../browser/flows/linkedin-post-analytics.js";
import { HttpError } from "../clients/http.js";
import { OAUTH_PROVIDERS } from "../oauth/providers.js";
import { pollWaits } from "./poll.js";
import {
  type ApiLeg,
  type OAuthSpec,
  route,
  type SiteApi,
  SiteError,
  type SiteRoute,
} from "./types.js";
import type { Seen, VerifyRead } from "./verdict.js";
import { arr, isoOf, rec, sameName, str, text, unclear } from "./verify-kit.js";
import { bytesOf } from "./youtube.js";

export const LINKEDIN_ORIGIN = "https://api.linkedin.com";
/** A PDF runs to 100 MB; its PUT gets this long. */
const UPLOAD_PUT_MS = 10 * 60_000;
/** A video is ready for a post once LinkedIn has processed it: ask with growing pauses, up to 5 minutes. */
const VIDEO_READY_MS = 5 * 60_000;
/**
 * LinkedIn versions its REST API by month; a version is honoured for a year, then every call
 * answers 426 NONEXISTENT_VERSION (202508 lapsed by 2026-10-13). 202609 runs to about 2027-09.
 */
export const LINKEDIN_VERSION = "202609";
/**
 * Pages Wren's account admins, by numeric id. The API says who posts with an
 * author URN; the browser leg reads the Page's name live and picks it off the
 * composer's author list, so a rename needs no change here.
 */
export const LINKEDIN_PAGES: ReadonlySet<string> = new Set([WREN_PAGE]);
/** Their handles (`/company/<handle>/`), so a comment the page shows by link names the Page's URN. */
const PAGE_HANDLES: Record<string, string> = { wrenautomation: WREN_PAGE };

const PAGE_URN = /^urn:li:organization:(\d+)$/;

/**
 * The grant acting as a Page through the API needs: Community Management, in review since
 * 2026-10-09. Until it is granted the browser leg acts as the Page; after, the API does.
 */
const asPage = (who: string, scope: string): string[] => (PAGE_URN.test(who) ? [scope] : []);

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
/** A comment: `urn:li:comment:(urn:li:activity:1,2)`, the post it is on and its own id. */
const commentUrn = z
  .string()
  .regex(/^urn:li:comment:\(urn:li:[a-zA-Z]+:\d+,\d+\)$/, "a LinkedIn comment URN");

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
/** On a post, or (`urn` a comment) an answer to it: then `object` is the post, `parentComment` the comment. */
const comment = z.object({
  urn: z.union([urn, commentUrn]),
  actor: urn,
  object: urn.optional(),
  parentComment: commentUrn.optional(),
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

const upload = z.object({
  kind: z.enum(["image", "document", "video"]),
  owner: urn,
  /** Where the bytes are: an https URL (a signed media link), never a path on this machine. */
  file: z.string().regex(/^https:\/\/\S+$/, "an https URL"),
});

const FEED = "https://www.linkedin.com/feed/update/";
const PROFILE = "https://www.linkedin.com/in/";

/** The post a comment URN sits on: `urn:li:comment:(urn:li:activity:1,2)` is on `urn:li:activity:1`. */
const postOf = (urn: string): string =>
  /^urn:li:comment:\((urn:li:[a-zA-Z]+:\d+),\d+\)$/.exec(urn)?.[1] ?? urn;

/** Where this account stands with a member, as the profile's buttons read (`GET /in/{vanity}/relationship`). */
async function relationshipOf(
  get: (path: string) => Promise<unknown>,
  vanity: string,
): Promise<"connected" | "pending" | "none" | null> {
  const r = text(rec(await get(`/in/${vanity}/relationship`)).relationship);
  return r === "connected" || r === "pending" || r === "none" ? r : null;
}

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
  /** Only authors whose job title says this ("founder"). */
  authorTitle: z.string().trim().min(1).max(100).optional(),
});
const companyPosts = z.object({ company: handle, max: postsMax });

interface VideoInit {
  value?: {
    video?: string;
    uploadToken?: string;
    uploadInstructions?: Array<{ uploadUrl: string; firstByte: number; lastByte: number }>;
  };
}

/**
 * The Videos API: start with the size, PUT each part LinkedIn names (its ETag is the part's id),
 * finalize, then wait until the video is AVAILABLE, since a post can't name it before.
 */
async function uploadVideo(leg: ApiLeg, owner: string, file: string): Promise<string> {
  const bytes = await bytesOf(file);
  const init = await must(
    await leg.http.json<VideoInit>(`${LINKEDIN_ORIGIN}/rest/videos?action=initializeUpload`, {
      method: "POST",
      headers: headers(leg),
      body: {
        initializeUploadRequest: {
          owner,
          fileSizeBytes: bytes.length,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      },
    }),
    "rest/videos",
  );
  const video = init?.value?.video;
  const parts = init?.value?.uploadInstructions ?? [];
  if (!video || parts.length === 0)
    throw new SiteError(502, "rest/videos: no video URN or upload parts in the answer");
  const ids: string[] = [];
  for (const part of parts) {
    const res = await leg.http.json<unknown>(part.uploadUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${leg.token}`,
        "content-type": "application/octet-stream",
      },
      raw: bytes.slice(part.firstByte, part.lastByte + 1),
      timeoutMs: UPLOAD_PUT_MS,
    });
    await must(res, "rest/videos (bytes)");
    const etag = res.headers.get("etag");
    if (!etag) throw new SiteError(502, "rest/videos: a part answered without its ETag");
    ids.push(etag);
  }
  await must(
    await leg.http.json<unknown>(`${LINKEDIN_ORIGIN}/rest/videos?action=finalizeUpload`, {
      method: "POST",
      headers: headers(leg),
      body: {
        finalizeUploadRequest: {
          video,
          uploadToken: init?.value?.uploadToken ?? "",
          uploadedPartIds: ids,
        },
      },
    }),
    "rest/videos (finalize)",
  );
  const waits = pollWaits(VIDEO_READY_MS);
  for (let n = 0; ; n++) {
    const v = await must(
      await leg.http.json<{ status?: string }>(
        `${LINKEDIN_ORIGIN}/rest/videos/${encodeURIComponent(video)}`,
        { headers: headers(leg) },
      ),
      "rest/videos (status)",
    );
    if (v?.status === "AVAILABLE") return video;
    if (v?.status === "PROCESSING_FAILED")
      throw new SiteError(422, `rest/videos: LinkedIn could not process ${video}`);
    const wait = waits[n];
    if (wait === undefined)
      throw new SiteError(
        504,
        `rest/videos: ${video} still ${v?.status ?? "unknown"} after 5 minutes`,
      );
    await new Promise((ok) => setTimeout(ok, wait));
  }
}

async function must<T>(res: { ok: boolean; status: number; body: T | null }, what: string) {
  if (!res.ok) throw new HttpError("CALL", `${LINKEDIN_ORIGIN}/${what}`, res.status);
  return res.body as T;
}

export const linkedinOAuth: OAuthSpec = {
  authorizeUrl: OAUTH_PROVIDERS.linkedin.authorize,
  tokenUrl: OAUTH_PROVIDERS.linkedin.token,
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
  const total = (use: Record<string, number>) => ({
    ...use,
    total: Object.values(use).reduce((n, k) => n + k, 0),
  });
  const used = r.used;
  return {
    ...r,
    meter: (q) => total(meter(q)),
    ...(used
      ? {
          used: (q, out) => {
            const u = used(q, out);
            return u && total(u);
          },
        }
      : {}),
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
    // One post's analytics page or the dashboard, on Wren's own account: wren reads its own numbers.
    analytics: 10,
    // Likes on others' posts and follows: wren's reach loop, as linkedin@wren only.
    like: 30,
    follow: 20,
    // Comments as the Page on others' posts (wren's reach loop) and reads of a post's comments.
    comment: 15,
    // Loads of our own post pages (comments, counts): 60 ran out by evening on 2026-10-23; reads of
    // our own posts are the lowest-risk load, so 150 (William).
    comments: 150,
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
      analytics: 0,
      like: 0,
      follow: 0,
      comment: 0,
      comments: 0,
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
      analytics: 0,
      like: 0,
      follow: 0,
      comment: 0,
      comments: 0,
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
      verify: {
        words: (b) => b.commentary,
        read: async (b, get): Promise<VerifyRead> => {
          const r = await get("/rest/posts", {
            q: "author",
            author: b.author,
            count: 10,
            sortBy: "CREATED",
          });
          return {
            rows: arr(rec(r).elements).map((e) => {
              const p = rec(e);
              const id = str(p.id);
              return {
                words: text(p.commentary),
                at: isoOf(p.publishedAt ?? p.createdAt),
                id,
                url: id ? `${FEED}${id}/` : null,
              };
            }),
            order: "newest",
            complete: false,
          };
        },
      },
      // The API answers the URN (`id`); the browser leg answers the post's link.
      sentAs: (o) => {
        const r = rec(o);
        const id = str(r.id);
        return { id, url: str(r.url) ?? (id ? `${FEED}${id}/` : null) };
      },
      needs: (b) => asPage(b.author, "w_organization_social"),
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
      summary:
        "The member's or Page's own posts, newest first (`q=author&author=urn:li:person:…&count&start`): id, commentary, publishedAt/createdAt (ms). Until the read grants land, the signed-in member's recent activity or the Page's Posts tab",
      request: listPosts,
      // A member's own posts are r_member_social, which LinkedIn grants to partners only.
      needs: (q) => [PAGE_URN.test(q.author) ? "r_organization_social" : "r_member_social"],
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
      meter: () => ({ posts: 1 }),
      browser: {
        flow: "linkedin/list-posts",
        input: (q) => ({ author: q.author, count: q.count, start: q.start }),
      },
    }),
    route({
      method: "GET",
      path: "/rest/posts/{urn}",
      summary:
        "One post. Until the read grants land, its page in the API's shape (`commentary`, `author`, `publishedAt`), plus authorName, authorUrl, headline, reactions, comments, url",
      request: byUrn,
      // Another member's post takes r_member_social, a Page's r_organization_social; the urn says neither.
      needs: ["r_member_social", "r_organization_social"],
      meter: () => ({ posts: 1 }),
      browser: { flow: "linkedin/post" },
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
      summary: "Reaction and comment counts for a post",
      request: byUrn,
      needs: ["r_organization_social"],
      // The page read loads the post like a comment read; a count the hourly comment read just
      // saw, or the API's answer, loads nothing.
      meter: () => ({ comments: 1 }),
      used: (_q, out) =>
        (out as { $read?: string } | undefined)?.$read === "page" ? { comments: 1 } : {},
      api: async ({ urn }, leg) =>
        must(
          await leg.http.json<unknown>(
            `${LINKEDIN_ORIGIN}/rest/socialActions/${encodeURIComponent(urn)}`,
            { headers: headers(leg) },
          ),
          "rest/socialActions/{urn}",
        ),
      browser: { flow: "linkedin/post-stats" },
    }),
    route({
      method: "GET",
      path: "/rest/socialActions/{urn}/comments",
      summary: "Comments on a post (`count&start`)",
      request: comments,
      needs: ["r_organization_social"],
      meter: () => ({ comments: 1 }),
      api: async ({ urn, count, start }, leg) =>
        must(
          await leg.http.json<unknown>(
            `${LINKEDIN_ORIGIN}/rest/socialActions/${encodeURIComponent(urn)}/comments?count=${count}&start=${start}`,
            { headers: headers(leg) },
          ),
          "rest/socialActions/{urn}/comments",
        ),
      browser: { flow: "linkedin/post-comments", input: (q) => ({ ...q, pages: PAGE_HANDLES }) },
    }),
    route({
      method: "POST",
      path: "/rest/socialActions/{urn}/comments",
      summary: "Comment on a post (or reply, when `urn` is a comment)",
      request: comment,
      irreversible: true,
      verify: {
        words: (b) => b.message.text,
        read: async (b, get): Promise<VerifyRead | Seen> => {
          const asPage = PAGE_URN.test(b.actor);
          // A member's comment names its author by a profile link, so the name says whose it is.
          const name = asPage ? null : str(rec(await get("/v2/userinfo")).name);
          if (!asPage && !name) return unclear("who the account is on LinkedIn did not come back");
          const parent = b.parentComment ?? (b.urn.startsWith("urn:li:comment:") ? b.urn : null);
          const r = await get(
            `/rest/socialActions/${encodeURIComponent(b.object ?? postOf(b.urn))}/comments`,
            { count: 100 },
          );
          return {
            // The same words under another comment, or by another person, are not ours.
            rows: arr(rec(r).elements).map((e) => {
              const c = rec(e);
              const by = asPage ? text(c.actor) === b.actor : sameName(c.actorName, name);
              return {
                words: text(rec(c.message).text),
                at: isoOf(rec(c.created).time),
                id: str(c.commentUrn) ?? str(c.$URN),
                url: null,
                mine: by && (str(c.parentComment) ?? null) === parent,
              };
            }),
            // LinkedIn orders them its own way, and the read stops at a count.
            order: "ranked",
            complete: false,
          };
        },
      },
      sentAs: (o) => {
        const r = rec(o);
        return { id: str(r.commentUrn) ?? str(r.$URN) ?? str(r.id), url: null };
      },
      // Commenting is partner-only for members too (403 partnerApiSocialActions.CREATE on
      // w_member_social, 2026-10-13): Community Management's feed scope, until then the browser.
      needs: (b) => [PAGE_URN.test(b.actor) ? "w_organization_social" : "w_member_social_feed"],
      meter: () => ({ comment: 1 }),
      api: async ({ urn, ...body }, leg) =>
        must(
          await leg.http.json<unknown>(
            `${LINKEDIN_ORIGIN}/rest/socialActions/${encodeURIComponent(urn)}/comments`,
            { method: "POST", headers: headers(leg), body },
          ),
          "rest/socialActions/{urn}/comments",
        ),
      browser: {
        flow: "linkedin/comment",
        input: (b) => ({
          urn: b.urn,
          text: b.message.text,
          actor: b.actor,
          page: composerPage(b.actor),
        }),
      },
    }),
    route({
      method: "POST",
      path: "/rest/images",
      summary:
        "Start an image upload: answers `uploadUrl` (PUT the bytes there) and the image URN for a post",
      request: initUpload,
      needs: (b) => asPage(b.initializeUploadRequest.owner, "w_organization_social"),
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
    route({
      method: "POST",
      path: "/upload",
      summary:
        "Upload an image, a document (PDF) or a video from an https URL in one call: answers the `urn` a post names",
      request: upload,
      needs: (b) => asPage(b.owner, "w_organization_social"),
      api: async (body, leg) => {
        if (body.kind === "video") return { urn: await uploadVideo(leg, body.owner, body.file) };
        const rest = body.kind === "image" ? "images" : "documents";
        const init = await must(
          await leg.http.json<{
            value?: { uploadUrl?: string; image?: string; document?: string };
          }>(`${LINKEDIN_ORIGIN}/rest/${rest}?action=initializeUpload`, {
            method: "POST",
            headers: headers(leg),
            body: { initializeUploadRequest: { owner: body.owner } },
          }),
          `rest/${rest}`,
        );
        const at = init?.value?.uploadUrl;
        const made = body.kind === "image" ? init?.value?.image : init?.value?.document;
        if (!at || !made)
          throw new SiteError(502, `rest/${rest}: no uploadUrl or URN in the answer`);
        await must(
          await leg.http.json<unknown>(at, {
            method: "PUT",
            headers: {
              authorization: `Bearer ${leg.token}`,
              "content-type": "application/octet-stream",
            },
            raw: await bytesOf(body.file),
            timeoutMs: UPLOAD_PUT_MS,
          }),
          `rest/${rest} (bytes)`,
        );
        return { urn: made };
      },
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
      summary:
        "Invite to connect, with an optional note (200 characters; five notes a month free): `{ sent: true, note }`, or `{ sent: false, relationship }` when no invite is offered (connected, pending, follow-only)",
      request: connect,
      irreversible: true,
      verify: {
        words: () => "",
        // A state, not words: an invite out (pending) or accepted (connected) went through.
        read: async (b, get): Promise<Seen> => {
          const now = await relationshipOf(get, b.vanity);
          if (now === "pending" || now === "connected")
            return { seen: "found", id: null, url: `${PROFILE}${b.vanity}/`, at: null };
          return now === "none"
            ? { seen: "absent" }
            : unclear("the profile's buttons were not clear");
        },
      },
      meter: () => ({ connect: 1 }),
      // No invite offered sent nothing: a profile look, not one of the day's invites.
      used: (_q, out) =>
        (out as { sent?: boolean } | null)?.sent === false ? { profile: 1 } : undefined,
      browser: { flow: "linkedin/connect" },
    }),
    route({
      method: "POST",
      path: "/in/{vanity}/follow",
      summary: "Follow a member (`undo` unfollows): `{ following, already? }`",
      request: z.object({ vanity, undo: z.boolean().optional() }),
      meter: () => ({ follow: 1 }),
      browser: { flow: "linkedin/follow" },
    }),
    route({
      method: "POST",
      path: "/company/{company}/follow",
      summary: "Follow a company page (`undo` unfollows): `{ following, already? }`",
      request: z.object({ company: handle, undo: z.boolean().optional() }),
      meter: () => ({ follow: 1 }),
      browser: { flow: "linkedin/follow" },
    }),
    route({
      method: "POST",
      path: "/feed/update/{urn}/like",
      summary: "Like someone's post (`undo` takes it back): `{ urn, liked, already? }`",
      request: z.object({
        urn: z.string().regex(POST_URN, "a post urn"),
        undo: z.boolean().optional(),
      }),
      meter: () => ({ like: 1 }),
      browser: { flow: "linkedin/like" },
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
      verify: {
        words: () => "",
        // The invite is gone (none) or still out (pending). Connected: it was accepted, not withdrawn.
        read: async (b, get): Promise<Seen> => {
          const now = await relationshipOf(get, b.vanity);
          if (now === "none")
            return { seen: "found", id: null, url: `${PROFILE}${b.vanity}/`, at: null };
          return now === "pending"
            ? { seen: "absent" }
            : unclear("the invite did not end as pending or none");
        },
      },
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
      path: "/analytics/post-summary/{urn}",
      summary:
        "A post's analytics page on Wren's own account (`urn`: activity, share or ugcPost, URL-encoded in the path): impressions, reached, reactions, comments, reposts, saves, sends, profileViewers, followersGained, and on a video videoViews, watchSecs, avgWatchSecs (null when the page shows none), raw. Reads only",
      request: z.object({ urn: z.string().regex(POST_URN, "a post urn") }),
      meter: () => ({ analytics: 1 }),
      browser: { flow: "linkedin/post-analytics" },
    }),
    route({
      method: "GET",
      path: "/analytics/dashboard",
      summary:
        "The account's own dashboard on Wren's account: profileViewers (past 90 days), searchAppearances (previous week), postImpressions (past 7 days), followers, each null when the page shows none, plus windows (each count's window words), url and raw. Reads only",
      request: z.object({}),
      meter: () => ({ analytics: 1 }),
      browser: { flow: "linkedin/dashboard" },
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
      verify: {
        words: (b) => b.text,
        read: async (b, get): Promise<VerifyRead> => {
          const r = await get("/messaging", { max: 40 });
          return {
            rows: arr(rec(r).conversations).map((e) => {
              const c = rec(e);
              const preview = text(c.preview).trim();
              const ours = /^you:\s*/i.test(preview);
              return {
                words: preview.replace(/^you:\s*/i, ""),
                // The list gives a relative label ("2h"), no time.
                at: null,
                id: null,
                url: str(c.url),
                // The list shows only the last message: another person's, or theirs, is not ours.
                mine: ours && sameName(c.vanity, b.vanity),
              };
            }),
            order: "ranked",
            complete: false,
          };
        },
      },
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
