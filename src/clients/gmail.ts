/** Gmail as one user (domain-wide delegation): the send-as signature, and plain mail for notifications. */
import { authedJson, type TokenSupplier } from "../google-auth.js";
import type { HttpClient } from "./http.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailUserClient {
  /** The primary send-as signature; idempotent. */
  setSignature(email: string, html: string): Promise<"set" | "kept">;
  send(mail: { from: string; to: string; subject: string; text: string }): Promise<void>;
}

export class GmailError extends Error {
  constructor(what: string, status: number, body: unknown) {
    const detail = (body as { error?: { message?: string } } | null)?.error?.message ?? "";
    super(`gmail ${what}: HTTP ${status} ${detail}`.trim());
    this.name = "GmailError";
  }
}

/** `tokenFor(user)` mints a supplier acting as that user with the scopes the call needs. */
export function gmailClient(opts: {
  tokenFor: (user: string, scopes: readonly string[]) => TokenSupplier;
  scopes: { settings: string; send: string };
  http: HttpClient;
}): GmailUserClient {
  return {
    async setSignature(email, html) {
      const token = opts.tokenFor(email, [opts.scopes.settings]);
      const url = `${GMAIL}/settings/sendAs/${encodeURIComponent(email)}`;
      const current = await authedJson<{ signature?: string }>(opts.http, token, url);
      if (current.status >= 400) throw new GmailError("get sendAs", current.status, current.body);
      if ((current.body?.signature ?? "") === html) return "kept";
      const r = await authedJson(opts.http, token, url, {
        method: "PATCH",
        body: { signature: html },
      });
      if (r.status >= 400) throw new GmailError("set signature", r.status, r.body);
      return "set";
    },
    async send(mail) {
      const token = opts.tokenFor(mail.from, [opts.scopes.send]);
      const raw = [
        `From: ${mail.from}`,
        `To: ${mail.to}`,
        `Subject: ${mail.subject}`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "",
        mail.text,
      ].join("\r\n");
      const r = await authedJson(opts.http, token, `${GMAIL}/messages/send`, {
        method: "POST",
        body: { raw: Buffer.from(raw).toString("base64url") },
      });
      if (r.status >= 400) throw new GmailError("send", r.status, r.body);
    },
  };
}
