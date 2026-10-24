/**
 * A site's own words on a refusal, read off the error body for an HttpError's note. Each reader
 * names the field its vendor uses (a code, a reason, a message) and never echoes a token.
 */
import { safeUrls } from "../clients/http.js";

/** A Graph error body: the code and subcode say what failed (never the token). */
export type GraphFailure = {
  error?: { code?: number; error_subcode?: number; message?: string; error_user_msg?: string };
};
export const graphNote = (body: unknown): string => {
  const e = (body as GraphFailure | null)?.error;
  return e?.code === undefined
    ? ""
    : `graph code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""}`;
};

/** The code and Graph's own words: they name the bad field, never the token. */
export const graphWhy = (body: unknown): string => {
  const msg = (body as GraphFailure | null)?.error?.message;
  return [graphNote(body), msg?.slice(0, 200)].filter(Boolean).join(": ");
};

/** Google's reason (rateLimitExceeded, insufficientPermissions, …) says what to do. */
export function googleReason(body: unknown): string {
  const err = (body as { error?: { errors?: { reason?: string }[]; status?: string } } | null)
    ?.error;
  return err?.errors?.[0]?.reason ?? err?.status ?? "";
}

/** Google's own words on a refusal (`error.message`), its URLs cut to origin and path. */
export function googleWords(body: unknown): string {
  const m = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === "string" ? safeUrls(m).slice(0, 300) : "";
}

/** The first 300 characters of the body as JSON: for a vendor with no error shape of its own. */
export const bodyWords = (body: unknown): string => JSON.stringify(body ?? "").slice(0, 300);
