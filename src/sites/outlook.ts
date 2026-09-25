/**
 * Outlook under Microsoft Graph's shape (`/me/messages`, `/me/sendMail`,
 * `/me/events`): mail and calendar for the account behind the `microsoft`
 * credential, personal or work. The API covers everything a mail client
 * does; the browser legs are for an account with no app registration yet
 * (Outlook on the web, same routes). The desktop app is the desktop leg's,
 * not this module's: `designs/2026-09-21-desktop-leg.md`.
 */
import { z } from "zod";
import { HttpError } from "../clients/http.js";
import { type ApiLeg, type OAuthSpec, route, type SiteApi } from "./types.js";

export const OUTLOOK_ORIGIN = "https://graph.microsoft.com";
const V1 = `${OUTLOOK_ORIGIN}/v1.0`;

const bearer = (leg: ApiLeg) => ({ authorization: `Bearer ${leg.token}` });

async function must<T>(res: { ok: boolean; status: number; body: T | null }, what: string) {
  if (!res.ok) throw new HttpError("CALL", `${V1}/${what}`, res.status);
  return res.body as T;
}

/** The common OData query knobs Graph reads take. */
const odata = z.object({
  $select: z.string().optional(),
  $filter: z.string().optional(),
  $search: z.string().optional(),
  $orderby: z.string().optional(),
  $top: z.coerce.number().int().positive().max(1000).optional(),
  $skip: z.coerce.number().int().nonnegative().optional(),
});
const recipient = z.object({
  emailAddress: z.object({ address: z.string(), name: z.string().optional() }),
});
const message = z.object({
  subject: z.string(),
  body: z.object({ contentType: z.enum(["Text", "HTML"]).default("Text"), content: z.string() }),
  toRecipients: z.array(recipient).min(1),
  ccRecipients: z.array(recipient).optional(),
  bccRecipients: z.array(recipient).optional(),
});
const sendMail = z.object({ message, saveToSentItems: z.boolean().default(true) });
const reply = z.object({ id: z.string(), comment: z.string() });
const byId = z.object({ id: z.string(), $select: z.string().optional() });
const when = z.object({ dateTime: z.string(), timeZone: z.string().default("UTC") });
const event = z.object({
  subject: z.string(),
  start: when,
  end: when,
  body: z
    .object({ contentType: z.enum(["Text", "HTML"]).default("Text"), content: z.string() })
    .optional(),
  attendees: z
    .array(
      z.object({
        emailAddress: recipient.shape.emailAddress,
        type: z.enum(["required", "optional"]).default("required"),
      }),
    )
    .optional(),
  location: z.object({ displayName: z.string() }).optional(),
  isOnlineMeeting: z.boolean().optional(),
});

const query = (base: string, q: Record<string, unknown>) => {
  const u = new URL(base);
  for (const [k, v] of Object.entries(q))
    if (v !== undefined && k !== "id") u.searchParams.set(k, String(v));
  return u.toString();
};
const get = async (leg: ApiLeg, path: string, q: Record<string, unknown> = {}) =>
  must(
    await leg.http.json<unknown>(query(`${V1}${path}`, q), { headers: bearer(leg) }),
    path.slice(1),
  );
const post = async (leg: ApiLeg, path: string, body: unknown) =>
  must(
    await leg.http.json<unknown>(`${V1}${path}`, { method: "POST", headers: bearer(leg), body }),
    path.slice(1),
  );

/** Microsoft identity platform, `common` tenant: personal and work accounts alike. */
export const outlookOAuth: OAuthSpec = {
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scopes: ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"],
  clientId: "MICROSOFT_CLIENT_ID",
  clientSecret: "MICROSOFT_CLIENT_SECRET",
  refreshToken: "OUTLOOK_REFRESH_TOKEN",
  params: { response_mode: "query", prompt: "select_account" },
  consent: { flow: "outlook/oauth-consent" },
};

export const outlook: SiteApi = {
  site: "outlook",
  origin: OUTLOOK_ORIGIN,
  probe: { path: "/me" },
  auth: { oauth: outlookOAuth },
  routes: [
    route({
      method: "GET",
      path: "/me",
      summary: "The signed-in account (displayName, mail, userPrincipalName)",
      request: z.object({ $select: z.string().optional() }),
      api: (q, leg) => get(leg, "/me", q),
      browser: { workflow: "outlook-whoami" },
    }),
    route({
      method: "GET",
      path: "/me/messages",
      summary: 'Mail, newest first; `$filter=isRead eq false`, `$search="from:x"`, `$top=`',
      request: odata,
      api: (q, leg) => get(leg, "/me/messages", q),
      browser: { workflow: "outlook-list-mail" },
    }),
    route({
      method: "GET",
      path: "/me/messages/{id}",
      summary: "One message with its body",
      request: byId,
      api: ({ id, ...q }, leg) => get(leg, `/me/messages/${encodeURIComponent(id)}`, q),
      browser: { workflow: "outlook-read-mail" },
    }),
    route({
      method: "POST",
      path: "/me/sendMail",
      summary: "Send a message (subject, body, toRecipients); saved to Sent",
      request: sendMail,
      irreversible: true,
      api: async (body, leg) => {
        await post(leg, "/me/sendMail", body);
        return { sent: true };
      },
      browser: { workflow: "outlook-send-mail" },
    }),
    route({
      method: "POST",
      path: "/me/messages/{id}/reply",
      summary: "Reply to a message with a comment",
      request: reply,
      irreversible: true,
      api: async ({ id, comment }, leg) => {
        await post(leg, `/me/messages/${encodeURIComponent(id)}/reply`, { comment });
        return { sent: true };
      },
      browser: { workflow: "outlook-reply" },
    }),
    route({
      method: "GET",
      path: "/me/events",
      summary:
        "Calendar events; `$filter=start/dateTime ge '2026-09-22'`, `$orderby=start/dateTime`",
      request: odata,
      api: (q, leg) => get(leg, "/me/events", q),
      browser: { workflow: "outlook-list-events" },
    }),
    route({
      method: "POST",
      path: "/me/events",
      summary: "Create an event (subject, start, end, attendees); invitations go out",
      request: event,
      irreversible: true,
      api: (body, leg) => post(leg, "/me/events", body),
      browser: { workflow: "outlook-create-event" },
    }),
  ],
  setup: [
    {
      name: "app-registration",
      makes: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
      how: {
        workflow: "microsoft-app-registration",
        input: { redirectUri: "http://127.0.0.1:9400/oauth/callback" },
      },
      summary:
        "On entra.microsoft.com (or portal.azure.com): an app registration for any account type, the web redirect URI, a client secret; keep the application (client) id and the secret",
    },
    {
      name: "consent",
      makes: ["OUTLOOK_REFRESH_TOKEN"],
      needs: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
      how: { oauth: outlookOAuth },
      summary:
        "Consent once as the account (mail, calendar, offline access); the refresh token is kept",
    },
  ],
};
