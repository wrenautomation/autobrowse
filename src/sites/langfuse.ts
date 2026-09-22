/**
 * Langfuse under its own REST shape: the trace back end read the same way
 * every other site is read. Its keys are minted in the browser (the
 * key-creation API is Enterprise-only), so `setup langfuse project-keys` is
 * a compiled flow on the project's settings page — the convention holds: a
 * person never copies a key by hand.
 *
 * Auth is Basic, not a bearer, so the "token" this site carries is the whole
 * `Basic <base64>` header value `langfuse wire` derives from the two keys.
 */
import { z } from "zod";
import { HttpError } from "../clients/http.js";
import { type ApiLeg, route, type SiteApi } from "./types.js";

export const LANGFUSE_ORIGIN = "https://cloud.langfuse.com";

/** The wired header value is already `Basic <base64(public:secret)>`. */
const basic = (leg: ApiLeg) => ({ authorization: leg.token });

async function must<T>(res: { ok: boolean; status: number; body: T | null }, what: string) {
  if (!res.ok) throw new HttpError("CALL", `${LANGFUSE_ORIGIN}${what}`, res.status);
  return res.body as T;
}

/** The window the new observations API insists on; the legacy trace APIs are closed to new orgs. */
const observations = z.object({
  fromStartTime: z.string().datetime().optional(),
  toStartTime: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(10),
  name: z.string().optional(),
  type: z.string().optional(),
});

const query = (i: Record<string, unknown>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(i)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
};

export const langfuse: SiteApi = {
  site: "langfuse",
  origin: LANGFUSE_ORIGIN,
  auth: { token: "LANGFUSE_BASIC_AUTH" },
  routes: [
    route({
      method: "GET",
      path: "/api/public/v2/observations",
      request: observations,
      api: async (i, leg) => {
        const now = Date.now();
        const from = i.fromStartTime ?? new Date(now - 3_600_000).toISOString();
        const to = i.toStartTime ?? new Date(now).toISOString();
        const path = `/api/public/v2/observations?${query({ ...i, fromStartTime: from, toStartTime: to })}`;
        return must(
          await leg.http.json<unknown>(`${LANGFUSE_ORIGIN}${path}`, { headers: basic(leg) }),
          path,
        );
      },
      summary:
        "The spans Langfuse holds in a time window (the model calls this system made); defaults to the last hour",
    }),
    route({
      method: "GET",
      path: "/api/public/projects",
      request: z.object({}),
      api: async (_i, leg) =>
        must(
          await leg.http.json<unknown>(`${LANGFUSE_ORIGIN}/api/public/projects`, {
            headers: basic(leg),
          }),
          "/api/public/projects",
        ),
      summary: "Which project these keys belong to: the cheapest proof a key pair is live",
    }),
  ],
  setup: [
    {
      name: "project-keys",
      makes: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"],
      how: {
        workflow: "langfuse-project-keys",
        input: { noteOptional: "autobrowse tracing" },
      },
      summary:
        "Mint a key pair on the project's API-keys page and keep both (the create-key API is Enterprise-only); then `autobrowse langfuse wire`",
    },
  ],
};
