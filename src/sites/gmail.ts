/**
 * Gmail under the API's shape (`/gmail/v1/users/me/...`), one consent per
 * account: the site's own token is `GMAIL_REFRESH_TOKEN`, another account's
 * is kept under `GMAIL_REFRESH_TOKEN__<ADDRESS>` (`site setup gmail consent
 * --account will@x.dev`). Any Google inbox becomes one this system reads
 * codes from and sends through, Workspace or not; the service account
 * (domain-wide delegation) stays the path for our own Workspace users.
 */
import { z } from "zod";
import { type JsonResponse, mustOk } from "../clients/http.js";
import { OAUTH_PROVIDERS } from "../oauth/providers.js";
import { type ApiLeg, type OAuthSpec, route, type SiteApi } from "./types.js";
import type { Seen, VerifyRead, VerifyRow } from "./verdict.js";
import { arr, isoOf, mimeText, rec, str, text, unclear } from "./verify-kit.js";
import { googleReason } from "./why.js";

export const GMAIL_ORIGIN = "https://gmail.googleapis.com";
const ME = `${GMAIL_ORIGIN}/gmail/v1/users/me`;

const bearer = (leg: ApiLeg) => ({ authorization: `Bearer ${leg.token}` });

const must = <T>(res: JsonResponse<T>, what: string): T =>
  mustOk(res, `${ME}/${what}`, googleReason);

/** The Subject and the addresses on To of an RFC 2822 message (base64url), decoded. */
export function headersOfRaw(raw: string): { subject: string; to: string[] } {
  const head =
    Buffer.from(raw, "base64url")
      .toString("utf8")
      .split(/\r?\n\r?\n/, 1)[0] ?? "";
  const field = (name: string) =>
    new RegExp(`^${name}:[ \\t]*((?:.*)(?:\\r?\\n[ \\t]+.*)*)`, "im").exec(head)?.[1] ?? "";
  return { subject: mimeText(field("Subject")), to: addressesOf(field("To")) };
}
const addressesOf = (v: string): string[] =>
  (v.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? []).map((a) => a.toLowerCase());

export const gmailOAuth: OAuthSpec = {
  authorizeUrl: OAUTH_PROVIDERS.google.authorize,
  tokenUrl: OAUTH_PROVIDERS.google.token,
  scopes: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.settings.basic",
  ],
  clientId: "GOOGLE_OAUTH_CLIENT_ID",
  clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
  refreshToken: "GMAIL_REFRESH_TOKEN",
  identity: { url: `${GMAIL_ORIGIN}/gmail/v1/users/me/profile`, field: "emailAddress" },
  params: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  consent: { flow: "google/oauth-consent" },
};

const list = z
  .object({
    q: z.string().optional(),
    maxResults: z.coerce.number().int().min(1).max(500).default(10),
    pageToken: z.string().optional(),
    labelIds: z.string().optional(),
  })
  .loose();
const get = z.object({
  id: z.string().min(1),
  format: z.enum(["full", "metadata", "minimal", "raw"]).default("full"),
});
const send = z.object({
  /** The RFC 2822 message, base64url as the API takes it. */
  raw: z.string().min(1),
  threadId: z.string().optional(),
});
/** Gmail publishes only to a topic in the OAuth client's own Cloud project. */
const watch = z.object({
  topicName: z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/),
  labelIds: z.array(z.string()).optional(),
  labelFilterBehavior: z.enum(["INCLUDE", "EXCLUDE"]).optional(),
});

export const gmail: SiteApi = {
  site: "gmail",
  origin: GMAIL_ORIGIN,
  probe: { path: "/gmail/v1/users/me/profile" },
  auth: { oauth: gmailOAuth },
  routes: [
    route({
      method: "GET",
      path: "/gmail/v1/users/me/profile",
      summary: "The account's address and history id",
      request: z.object({}).loose(),
      api: async (_q, leg) =>
        must(await leg.http.json<unknown>(`${ME}/profile`, { headers: bearer(leg) }), "profile"),
    }),
    route({
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      summary:
        "List message ids: `q` as the search box takes it (`after:1700000000 from:x`), `maxResults`, `pageToken`",
      request: list,
      api: async (q, leg) => {
        const u = new URL(`${ME}/messages`);
        for (const [k, v] of Object.entries(q))
          if (v !== undefined) u.searchParams.set(k, String(v));
        return must(
          await leg.http.json<unknown>(u.toString(), { headers: bearer(leg) }),
          "messages",
        );
      },
    }),
    route({
      method: "GET",
      path: "/gmail/v1/users/me/messages/{id}",
      summary: "One message; `format` full (default), metadata, minimal or raw",
      request: get,
      api: async ({ id, format }, leg) =>
        must(
          await leg.http.json<unknown>(
            `${ME}/messages/${encodeURIComponent(id)}?format=${format}`,
            { headers: bearer(leg) },
          ),
          `messages/${id}`,
        ),
    }),
    route({
      method: "POST",
      path: "/gmail/v1/users/me/messages/send",
      summary: "Send a message: `raw` is the whole RFC 2822 message, base64url",
      request: send,
      irreversible: true,
      verify: {
        words: (b) => headersOfRaw(b.raw).subject,
        read: async (b, look): Promise<VerifyRead | Seen> => {
          const sent = headersOfRaw(b.raw);
          if (!sent.subject || !sent.to.length) return unclear("the message has no subject or To");
          const MAX = 10;
          const list = rec(
            await look("/gmail/v1/users/me/messages", { q: "in:sent", maxResults: MAX }),
          );
          const ids = arr(list.messages).flatMap((m) => str(rec(m).id) ?? []);
          // The list holds ids only: each message is read for its headers.
          const rows = await Promise.all(
            ids.map(async (id): Promise<VerifyRow> => {
              const m = rec(
                await look(`/gmail/v1/users/me/messages/${id}`, { format: "metadata" }),
              );
              const headers = arr(rec(m.payload).headers).map(rec);
              const header = (name: string) =>
                text(headers.find((h) => text(h.name).toLowerCase() === name)?.value);
              const to = addressesOf(header("to"));
              return {
                words: mimeText(header("subject")),
                at: isoOf(m.internalDate),
                id,
                url: `https://mail.google.com/mail/#all/${id}`,
                // The same subject to another person is another message.
                mine: sent.to.every((a) => to.includes(a)),
              };
            }),
          );
          return {
            rows: rows.sort((a, c) => (c.at ?? "").localeCompare(a.at ?? "")),
            order: "newest",
            complete: ids.length < MAX && !str(list.nextPageToken),
          };
        },
      },
      sentAs: (o) => {
        const id = str(rec(o).id);
        return { id, url: id ? `https://mail.google.com/mail/#all/${id}` : null };
      },
      api: async (body, leg) =>
        must(
          await leg.http.json<unknown>(`${ME}/messages/send`, {
            method: "POST",
            headers: bearer(leg),
            body,
          }),
          "messages/send",
        ),
    }),
    route({
      method: "POST",
      path: "/gmail/v1/users/me/watch",
      summary:
        "Push this inbox's changes to a Pub/Sub topic for 7 days; again renews. Answers `historyId`, `expiration` (ms)",
      request: watch,
      api: async (body, leg) =>
        must(
          await leg.http.json<{ historyId: string; expiration: string }>(`${ME}/watch`, {
            method: "POST",
            headers: bearer(leg),
            body,
          }),
          "watch",
        ),
    }),
  ],
  setup: [
    {
      name: "oauth-client",
      makes: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
      needs: ["GOOGLE_CLOUD_PROJECT"],
      how: {
        workflow: "google-cloud-oauth-client",
        input: {
          project: { env: "GOOGLE_CLOUD_PROJECT" },
          api: "gmail.googleapis.com",
          appName: { env: "OPERATOR_NAME" },
          email: { account: true },
          clientName: "autobrowse",
          redirectUri: "http://127.0.0.1:9400/oauth/callback",
        },
      },
      summary:
        "In Google Cloud Console: enable the Gmail API on the project, the same Web OAuth client YouTube uses (its id and secret are shared)",
      purpose: "pays",
    },
    {
      name: "consent",
      makes: ["GMAIL_REFRESH_TOKEN"],
      needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
      how: { oauth: gmailOAuth },
      summary:
        "Consent once as the inbox's Google account (offline access); `--account <address>` keeps another account's token under its own name",
    },
  ],
};
