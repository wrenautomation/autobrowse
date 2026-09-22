/**
 * Tracing for model calls, one seam: `tracedLlm` wraps any `Llm` and hands
 * a span per `complete` to a sink. `withTrace` names the run and step the
 * call belongs to (an AsyncLocalStorage, so the agent loop sets it once
 * and every call under it is tagged). The one sink here speaks OTLP/JSON
 * over HTTP, which Langfuse, Honeycomb, Grafana, Jaeger and Datadog all
 * take, so there is no vendor SDK and nothing runs when no endpoint is
 * set. A span carries sizes, hashes and counts, never a prompt or a reply.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import type { HttpClient } from "../clients/http.js";
import type { Llm, LlmReply, LlmRequest } from "./types.js";

export interface TraceContext {
  /** The agent session, compile or repair this call serves; the trace id derives from it. */
  session: string;
  step?: number;
}

const context = new AsyncLocalStorage<TraceContext>();

export function withTrace<T>(ctx: TraceContext, fn: () => Promise<T>): Promise<T> {
  return context.run(ctx, fn);
}

export function currentTrace(): TraceContext | undefined {
  return context.getStore();
}

export interface LlmSpan {
  name: "llm.complete";
  /** 32 hex chars, stable per session so a run's calls sit in one trace. */
  traceId: string;
  spanId: string;
  /** Unix ms; OTLP wants ns, which `otlpBody` makes. */
  startMs: number;
  endMs: number;
  ok: boolean;
  attributes: Record<string, string | number | boolean>;
}

export interface TraceSink {
  span(s: LlmSpan): void;
  /** Send what is buffered; resolves once it is out (or given up on). */
  flush(): Promise<void>;
}

export const traceIdOf = (session: string): string =>
  createHash("sha256").update(session).digest("hex").slice(0, 32);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Every `complete` becomes one span; the call itself is untouched, a sink error never reaches the caller. */
export function tracedLlm(llm: Llm, sink: TraceSink): Llm {
  return {
    id: llm.id,
    async complete(req: LlmRequest): Promise<LlmReply> {
      const ctx = currentTrace();
      const startMs = Date.now();
      const base: LlmSpan["attributes"] = {
        "llm.id": llm.id,
        "llm.json": req.json ?? false,
        "llm.prompt.chars": req.prompt.length,
        "llm.system.sha": sha(req.system),
        "llm.prompt.sha": sha(req.prompt),
        ...(ctx ? { "autobrowse.session": ctx.session } : {}),
        ...(ctx?.step !== undefined ? { "autobrowse.step": ctx.step } : {}),
      };
      const emit = (ok: boolean, more: LlmSpan["attributes"]) => {
        try {
          sink.span({
            name: "llm.complete",
            traceId: traceIdOf(ctx?.session ?? `call-${randomBytes(8).toString("hex")}`),
            spanId: randomBytes(8).toString("hex"),
            startMs,
            endMs: Date.now(),
            ok,
            attributes: { ...base, ...more },
          });
        } catch {
          // a sink never fails a model call
        }
      };
      try {
        const reply = await llm.complete(req);
        emit(true, {
          "llm.model": reply.model,
          "llm.usage.input_tokens": reply.usage.inputTokens,
          "llm.usage.output_tokens": reply.usage.outputTokens,
          "llm.reply.chars": reply.text.length,
        });
        return reply;
      } catch (err) {
        emit(false, { "error.type": err instanceof Error ? err.name : "Error" });
        throw err;
      }
    },
  };
}

export interface OtlpOptions {
  /** `OTEL_EXPORTER_OTLP_ENDPOINT`: the base; spans go to `<base>/v1/traces`. */
  endpoint: string;
  /** `OTEL_EXPORTER_OTLP_HEADERS`: `k=v,k2=v2` (an Authorization header for Langfuse or Honeycomb). */
  headers?: string | undefined;
  serviceName?: string | undefined;
  http: HttpClient;
  /** Spans wait for a batch this big, or `flushMs`, whichever first. */
  batch?: number;
  flushMs?: number;
}

/** Parse `k=v,k2=v2` (URL-encoded values allowed, as the OTel spec says). */
export function parseOtlpHeaders(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (text ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

const attr = (k: string, v: string | number | boolean) => ({
  key: k,
  value:
    typeof v === "string"
      ? { stringValue: v }
      : typeof v === "boolean"
        ? { boolValue: v }
        : Number.isInteger(v)
          ? { intValue: String(v) }
          : { doubleValue: v },
});

/** The OTLP/JSON body for a batch of spans (one resource, one scope). */
export function otlpBody(spans: readonly LlmSpan[], serviceName: string): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", serviceName)] },
        scopeSpans: [
          {
            scope: { name: "autobrowse.llm" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              name: s.name,
              kind: 3, // CLIENT
              startTimeUnixNano: `${s.startMs}000000`,
              endTimeUnixNano: `${s.endMs}000000`,
              attributes: Object.entries(s.attributes).map(([k, v]) => attr(k, v)),
              status: { code: s.ok ? 1 : 2 },
            })),
          },
        ],
      },
    ],
  };
}

const MAX_BUFFER = 1_000;

export function otlpSink(o: OtlpOptions): TraceSink {
  const url = `${o.endpoint.replace(/\/+$/, "")}/v1/traces`;
  const headers = parseOtlpHeaders(o.headers);
  const service = o.serviceName ?? "autobrowse";
  const batch = o.batch ?? 20;
  const flushMs = o.flushMs ?? 5_000;
  let buffer: LlmSpan[] = [];
  let timer: NodeJS.Timeout | null = null;
  let sending: Promise<void> = Promise.resolve();
  const send = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return sending;
    const spans = buffer;
    buffer = [];
    // One request in flight at a time, in order; a failed batch is dropped, not retried forever.
    sending = sending
      .then(() => o.http.json(url, { method: "POST", headers, body: otlpBody(spans, service) }))
      .then(
        () => undefined,
        () => undefined,
      );
    return sending;
  };
  return {
    span(s) {
      if (buffer.length >= MAX_BUFFER) buffer.shift();
      buffer.push(s);
      if (buffer.length >= batch) void send();
      else if (!timer) {
        timer = setTimeout(() => void send(), flushMs);
        timer.unref();
      }
    },
    flush: send,
  };
}

export function memorySink(): TraceSink & { spans: LlmSpan[] } {
  const spans: LlmSpan[] = [];
  return {
    spans,
    span: (s) => {
      spans.push(s);
    },
    flush: async () => undefined,
  };
}
