/**
 * Langfuse as this system's trace back end. The keys are minted in the
 * browser (the API that creates keys is Enterprise-only), kept in the env
 * store, and everything after that is arithmetic: Langfuse takes OTLP over
 * HTTP with Basic auth, which is exactly what `otlpSink` already speaks. So
 * wiring tracing is deriving three env names from two keys — no SDK, no
 * vendor client, and the same three names point at Honeycomb or anything
 * else tomorrow.
 */
import type { EnvStore } from "../deps/env-store.js";

export const LANGFUSE_PUBLIC_KEY = "LANGFUSE_PUBLIC_KEY";
export const LANGFUSE_SECRET_KEY = "LANGFUSE_SECRET_KEY";
export const LANGFUSE_BASE_URL = "LANGFUSE_BASE_URL";
export const OTLP_ENDPOINT = "OTEL_EXPORTER_OTLP_ENDPOINT";
export const OTLP_HEADERS = "OTEL_EXPORTER_OTLP_HEADERS";
export const OTLP_SERVICE = "OTEL_SERVICE_NAME";
/** The same Basic value the OTLP header carries, on its own, for the `langfuse` site API. */
export const LANGFUSE_BASIC_AUTH = "LANGFUSE_BASIC_AUTH";

export const LANGFUSE_CLOUD = "https://cloud.langfuse.com";

/** What Langfuse's OTLP door wants: `Authorization=Basic base64(public:secret)`. */
export function otlpHeaderValue(publicKey: string, secretKey: string): string {
  return `Authorization=Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

export interface WireResult {
  /** Names written, in order; never their values. */
  wrote: readonly string[];
  endpoint: string;
}

/**
 * Point the trace sink at Langfuse from the keys already in the store.
 * Idempotent: the same keys derive the same header.
 */
export async function wireTracing(
  env: EnvStore,
  o: { serviceName?: string; baseUrl?: string } = {},
): Promise<WireResult> {
  const [publicKey, secretKey] = await Promise.all([
    env.get(LANGFUSE_PUBLIC_KEY),
    env.get(LANGFUSE_SECRET_KEY),
  ]);
  if (!publicKey || !secretKey)
    throw new Error(
      `no Langfuse keys in the store: run \`autobrowse site setup langfuse project-keys\` first (${LANGFUSE_PUBLIC_KEY}, ${LANGFUSE_SECRET_KEY})`,
    );
  const base = (o.baseUrl ?? (await env.get(LANGFUSE_BASE_URL)) ?? LANGFUSE_CLOUD).replace(
    /\/+$/,
    "",
  );
  const endpoint = `${base}/api/public/otel`;
  const wrote: string[] = [];
  const put = async (name: string, value: string) => {
    await env.put(name, value);
    wrote.push(name);
  };
  await put(LANGFUSE_BASE_URL, base);
  await put(OTLP_ENDPOINT, endpoint);
  await put(OTLP_HEADERS, otlpHeaderValue(publicKey, secretKey));
  await put(OTLP_SERVICE, o.serviceName ?? "autobrowse");
  await put(
    LANGFUSE_BASIC_AUTH,
    `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
  );
  return { wrote, endpoint };
}

/** The one header the wired value encodes, as a header map. */
function headerMap(headers: string): Record<string, string> {
  const i = headers.indexOf("=");
  return { [headers.slice(0, i).trim()]: headers.slice(i + 1).trim() };
}

/** One trace-shaped ping through the same door the sink uses, so "wired" is proven, not assumed. */
export async function checkTracing(
  env: EnvStore,
  fetchJson: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ status: number }>,
): Promise<{ ok: boolean; status: number }> {
  const [endpoint, headers] = await Promise.all([env.get(OTLP_ENDPOINT), env.get(OTLP_HEADERS)]);
  if (!endpoint || !headers)
    throw new Error("tracing is not wired: run `autobrowse langfuse wire`");
  const { status } = await fetchJson(`${endpoint.replace(/\/+$/, "")}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headerMap(headers) },
    body: JSON.stringify({ resourceSpans: [] }),
  });
  return { ok: status >= 200 && status < 300, status };
}

export interface RecentSpan {
  name: string;
  traceId: string;
  startTime: string;
  type: string;
}

/**
 * Read the spans back out. Posting proves the door opens; only a read proves
 * a span landed — and a short-lived CLI is exactly where a span goes missing.
 * The v2 observations API is the one Langfuse leaves open to new orgs.
 */
export async function recentSpans(
  env: EnvStore,
  fetchJson: (
    url: string,
    init: { headers: Record<string, string> },
  ) => Promise<{ status: number; body: unknown }>,
  o: { minutes?: number; limit?: number } = {},
): Promise<RecentSpan[]> {
  const [base, headers] = await Promise.all([env.get(LANGFUSE_BASE_URL), env.get(OTLP_HEADERS)]);
  if (!base || !headers) throw new Error("tracing is not wired: run `autobrowse langfuse wire`");
  const to = new Date();
  const from = new Date(to.getTime() - (o.minutes ?? 60) * 60_000);
  const url =
    `${base.replace(/\/+$/, "")}/api/public/v2/observations` +
    `?fromStartTime=${from.toISOString()}&toStartTime=${to.toISOString()}&limit=${o.limit ?? 10}`;
  const { status, body } = await fetchJson(url, { headers: headerMap(headers) });
  if (status < 200 || status >= 300) throw new Error(`Langfuse said ${status} reading spans back`);
  const data = (body as { data?: RecentSpan[] } | null)?.data ?? [];
  return data.map((d) => ({
    name: d.name,
    traceId: d.traceId,
    startTime: d.startTime,
    type: d.type,
  }));
}
