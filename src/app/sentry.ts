/**
 * Sentry, when `SENTRY_DSN` is set: uncaught errors from the process, and
 * every failed run and failed step from the event bus, tagged by
 * workflow/key/step so one failing site is one issue. Events carry no
 * secrets (the bus rule); nothing else is sent.
 */
import * as Sentry from "@sentry/node";
import type { RunEvent } from "../engine/events.js";

export interface SentryOptions {
  dsn: string;
  environment: string;
  release?: string;
}

export interface ErrorSink {
  /** Report one run event, when it is worth an issue; returns whether it was. */
  event(e: RunEvent): boolean;
  error(err: unknown, context?: Record<string, string>): void;
  flush(): Promise<void>;
}

/** Which bus events become issues: failed steps and failed runs. */
export function issueOf(e: RunEvent): { message: string; tags: Record<string, string> } | null {
  const tags = { workflow: e.run.workflow, key: e.run.key };
  if (e.type === "step" && e.result.status === "failed")
    return {
      message: `${e.run.workflow}/${e.step}: ${e.result.detail}`,
      tags: { ...tags, step: e.step },
    };
  if (e.type === "finished" && e.status === "failed")
    return { message: `${e.run.workflow}/${e.run.key} failed: ${e.summary}`, tags };
  return null;
}

export function initSentry(opts: SentryOptions): ErrorSink {
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    ...(opts.release ? { release: opts.release } : {}),
    // Traces are noise for a worker; errors are the signal.
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
  return {
    event(e) {
      const issue = issueOf(e);
      if (!issue) return false;
      Sentry.captureMessage(issue.message, { level: "error", tags: issue.tags });
      return true;
    },
    error(err, context = {}) {
      Sentry.captureException(err, { tags: context });
    },
    flush: async () => void (await Sentry.flush(2_000)),
  };
}
