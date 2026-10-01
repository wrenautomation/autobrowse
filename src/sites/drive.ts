/**
 * Google Drive under the API's shape (`/drive/v3/...`), read only, one
 * consent per account like Gmail: the site's own token is
 * `DRIVE_REFRESH_TOKEN`, another account's `DRIVE_REFRESH_TOKEN__<ADDRESS>`
 * (`site setup drive consent --account will@x.dev`). Enough to walk a folder
 * and read its documents as text; nothing here writes to Drive.
 */
import { z } from "zod";
import { HttpError } from "../clients/http.js";
import { type ApiLeg, type OAuthSpec, route, type SiteApi } from "./types.js";

export const DRIVE_ORIGIN = "https://www.googleapis.com";
const FILES = `${DRIVE_ORIGIN}/drive/v3/files`;

const bearer = (leg: ApiLeg) => ({ authorization: `Bearer ${leg.token}` });

async function must<T>(res: { ok: boolean; status: number; body: T | null }, what: string) {
  if (!res.ok) {
    const err = (res.body as { error?: { errors?: { reason?: string }[]; status?: string } } | null)
      ?.error;
    throw new HttpError(
      "CALL",
      `${FILES}/${what}`,
      res.status,
      err?.errors?.[0]?.reason ?? err?.status ?? "",
    );
  }
  return res.body as T;
}

export const driveOAuth: OAuthSpec = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  clientId: "GOOGLE_OAUTH_CLIENT_ID",
  clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
  refreshToken: "DRIVE_REFRESH_TOKEN",
  identity: { url: `${DRIVE_ORIGIN}/drive/v3/about?fields=user`, field: "user.emailAddress" },
  params: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  consent: { flow: "google/oauth-consent" },
};

const list = z
  .object({
    q: z.string().optional(),
    pageSize: z.coerce.number().int().min(1).max(1000).default(100),
    pageToken: z.string().optional(),
    fields: z.string().default("nextPageToken,files(id,name,mimeType,modifiedTime,size,parents)"),
    orderBy: z.string().optional(),
  })
  .loose();
const exportQ = z.object({ id: z.string().min(1), mimeType: z.string().default("text/plain") });
const get = z.object({ id: z.string().min(1), alt: z.enum(["json", "media"]).default("json") });

export const drive: SiteApi = {
  site: "drive",
  origin: DRIVE_ORIGIN,
  probe: { path: "/drive/v3/about?fields=user" },
  auth: { oauth: driveOAuth },
  routes: [
    route({
      method: "GET",
      path: "/drive/v3/about",
      summary: "Whose Drive this token opens",
      request: z.object({}).loose(),
      api: async (_q, leg) =>
        must(
          await leg.http.json<unknown>(`${DRIVE_ORIGIN}/drive/v3/about?fields=user`, {
            headers: bearer(leg),
          }),
          "about",
        ),
    }),
    route({
      method: "GET",
      path: "/drive/v3/files",
      summary:
        "List files: `q` as the API takes it (`'<folderId>' in parents`, `name = 'x'`), `pageSize`, `pageToken`, `fields`",
      request: list,
      api: async (q, leg) => {
        const u = new URL(FILES);
        for (const [k, v] of Object.entries(q))
          if (v !== undefined) u.searchParams.set(k, String(v));
        return must(await leg.http.json<unknown>(u.toString(), { headers: bearer(leg) }), "");
      },
    }),
    route({
      method: "GET",
      path: "/drive/v3/files/{id}",
      summary: "One file's metadata; `alt=media` downloads a non-Google file's bytes as text",
      request: get,
      api: async ({ id, alt }, leg) => {
        const u = `${FILES}/${encodeURIComponent(id)}?${alt === "media" ? "alt=media" : "fields=id,name,mimeType,modifiedTime,size,parents,webViewLink"}`;
        if (alt === "media") {
          const res = await leg.http.json<unknown>(u, {
            headers: { ...bearer(leg), accept: "*/*" },
          });
          if (!res.ok) throw new HttpError("CALL", u, res.status, "");
          return { text: res.text ?? "" };
        }
        return must(await leg.http.json<unknown>(u, { headers: bearer(leg) }), id);
      },
    }),
    route({
      method: "GET",
      path: "/drive/v3/files/{id}/export",
      summary:
        "A Google Doc, Sheet or Slides as text (`mimeType` text/plain by default, text/csv for a sheet)",
      request: exportQ,
      api: async ({ id, mimeType }, leg) => {
        const u = `${FILES}/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mimeType)}`;
        const res = await leg.http.json<unknown>(u, { headers: { ...bearer(leg), accept: "*/*" } });
        if (!res.ok) throw new HttpError("CALL", u, res.status, "");
        return { text: res.text ?? "" };
      },
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
          api: "drive.googleapis.com",
          appName: "Wren Automation",
          email: { account: true },
          clientName: "autobrowse",
          redirectUri: "http://127.0.0.1:9400/oauth/callback",
        },
      },
      summary:
        "In Google Cloud Console: enable the Drive API on the project; the Web OAuth client is the one Gmail and YouTube share",
      purpose: "pays",
    },
    {
      name: "consent",
      makes: ["DRIVE_REFRESH_TOKEN"],
      needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
      how: { oauth: driveOAuth },
      summary:
        "Consent once as the Drive's Google account (read only, offline); `--account <address>` keeps another account's token under its own name",
    },
  ],
};
