/**
 * Cal.com under its v2 API's shape: the bookings wren's pilot page takes,
 * read the way every other site is read. Each call carries the
 * `cal-api-version` its endpoint is pinned to; a caller may pass its own.
 * The key is minted in the browser (`setup calcom token`) and never
 * expires, so nothing renews it.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CALCOM_API_KEY } from "../browser/flows/calcom-api-key.js";
import { HttpError } from "../clients/http.js";
import { type ApiLeg, route, type SiteApi } from "./types.js";

export const CALCOM_ORIGIN = "https://api.cal.com";

/** The versions Cal.com's docs pin each endpoint family to (2026). */
const VERSION = { bookings: "2024-08-13", eventTypes: "2024-06-14" } as const;

/** Query params pass through as the API takes them; `cal-api-version` is the header's. */
const passthrough = z
  .object({ "cal-api-version": z.string().optional() })
  .catchall(z.union([z.string(), z.number(), z.boolean()]));
type Query = z.infer<typeof passthrough>;

async function get(leg: ApiLeg, path: string, version: string | null, q: Query = {}) {
  const { "cal-api-version": asked, ...rest } = q;
  const qs = new URLSearchParams(
    Object.entries(rest).map(([k, v]) => [k, String(v)] as [string, string]),
  ).toString();
  const url = `${CALCOM_ORIGIN}${path}${qs ? `?${qs}` : ""}`;
  const v = asked ?? version;
  const res = await leg.http.json<unknown>(url, {
    headers: { authorization: `Bearer ${leg.token}`, ...(v ? { "cal-api-version": v } : {}) },
  });
  // The URL carries query params only; the key rides in the header.
  if (!res.ok) throw new HttpError("GET", url, res.status);
  return res.body;
}

async function send<T>(leg: ApiLeg, method: "POST" | "DELETE", path: string, body?: unknown) {
  const url = `${CALCOM_ORIGIN}${path}`;
  const res = await leg.http.json<T & { error?: { message?: string } }>(url, {
    method,
    headers: { authorization: `Bearer ${leg.token}` },
    ...(body === undefined ? {} : { body }),
  });
  if (!res.ok) throw new HttpError(method, url, res.status, res.body?.error?.message ?? "");
  return res.body as T;
}

/** A webhook as Cal.com lists it, minus its signing secret. */
interface CalcomWebhook {
  id: number | string;
  subscriberUrl: string;
  triggers: string[];
  active: boolean;
  secret?: string;
}
const bareHook = ({ secret: _s, ...w }: CalcomWebhook) => w;

/** What a booking webhook fires on: a call made, moved or called off. */
export const BOOKING_TRIGGERS = ["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED"];

export const calcom: SiteApi = {
  site: "calcom",
  origin: CALCOM_ORIGIN,
  probe: { path: "/v2/me" },
  auth: { token: CALCOM_API_KEY },
  routes: [
    route({
      method: "GET",
      path: "/v2/me",
      request: z.object({}),
      api: (_i, leg) => get(leg, "/v2/me", null),
      summary: "Who the key belongs to: the cheapest proof it is live",
    }),
    route({
      method: "GET",
      path: "/v2/bookings",
      request: passthrough,
      api: (q, leg) => get(leg, "/v2/bookings", VERSION.bookings, q),
      summary:
        "Bookings, filtered as Cal.com filters them (status, attendeeEmail, eventTypeId, afterStart, take, skip, …); each carries its metadata and utm fields",
    }),
    route({
      method: "GET",
      path: "/v2/bookings/{bookingUid}",
      request: passthrough.extend({ bookingUid: z.string().min(1) }),
      api: ({ bookingUid, ...q }, leg) =>
        get(leg, `/v2/bookings/${encodeURIComponent(bookingUid)}`, VERSION.bookings, q),
      summary: "One booking by its uid",
    }),
    route({
      method: "GET",
      path: "/v2/event-types",
      request: passthrough,
      api: (q, leg) => get(leg, "/v2/event-types", VERSION.eventTypes, q),
      summary:
        "The account's event types (the pilot call among them), with their slugs and lengths",
    }),
    route({
      method: "GET",
      path: "/v2/webhooks",
      request: z.object({}),
      api: async (_i, leg) => {
        const r = (await get(leg, "/v2/webhooks", null)) as { data?: CalcomWebhook[] };
        return (r.data ?? []).map(bareHook);
      },
      summary: "The account's webhooks (url, triggers, active), never their secrets",
    }),
    route({
      method: "POST",
      path: "/v2/webhooks",
      request: z.object({
        subscriberUrl: z.string().url(),
        triggers: z.array(z.string()).min(1).default(BOOKING_TRIGGERS),
        /** Env name the signing secret is kept under; autobrowse makes the secret, the answer never has it. */
        keep: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      }),
      api: async ({ subscriberUrl, triggers, keep }, leg) => {
        if (!leg.keep) throw new Error("calcom: no sink to keep the webhook secret in");
        const secret = randomBytes(32).toString("hex");
        // Kept before Cal.com has it: a lost answer leaves a secret with no hook, never a hook nobody can verify.
        await leg.keep(keep, secret);
        const r = await send<{ data: CalcomWebhook }>(leg, "POST", "/v2/webhooks", {
          active: true,
          subscriberUrl,
          triggers,
          secret,
          version: "2021-10-20",
        });
        return { ...bareHook(r.data), kept: keep };
      },
      summary:
        "Make a webhook (default: bookings made, moved, cancelled) signed with a fresh secret kept as `keep` in the sink; the secret is never returned",
    }),
    route({
      method: "DELETE",
      path: "/v2/webhooks/{webhookId}",
      request: z.object({ webhookId: z.string().min(1) }),
      api: async ({ webhookId }, leg) => {
        await send(leg, "DELETE", `/v2/webhooks/${encodeURIComponent(webhookId)}`);
        return { deleted: webhookId };
      },
      summary: "Delete a webhook by id",
    }),
  ],
  setup: [
    {
      name: "token",
      makes: [CALCOM_API_KEY],
      how: { flow: "calcom/api-key", input: { name: "autobrowse" } },
      summary:
        "Mint a Cal.com API key that never expires (Settings → Developer → API keys) and keep it as CALCOM_API_KEY",
    },
  ],
};
