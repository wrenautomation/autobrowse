/**
 * Google Workspace Admin: domains and users through the Directory API,
 * domain ownership through Site Verification, acting as the super admin.
 * Everything here is get-before-create, so a step can run twice.
 */
import { authedJson, type TokenSupplier } from "../google-auth.js";
import type { HttpClient } from "./http.js";

const DIRECTORY = "https://admin.googleapis.com/admin/directory/v1";
const VERIFY = "https://www.googleapis.com/siteVerification/v1";

export interface WorkspaceDomain {
  domainName: string;
  verified: boolean;
}

export interface NewUser {
  primaryEmail: string;
  givenName: string;
  familyName: string;
  password: string;
}

export interface GoogleAdminClient {
  getDomain(domain: string): Promise<WorkspaceDomain | null>;
  addDomain(domain: string): Promise<WorkspaceDomain>;
  /** The `google-site-verification=…` TXT value for the domain. */
  verificationToken(domain: string): Promise<string>;
  /** Ask Google to check the TXT; false when it is not visible yet. */
  verifyDomain(domain: string): Promise<boolean>;
  getUser(email: string): Promise<{ primaryEmail: string } | null>;
  createUser(user: NewUser): Promise<{ primaryEmail: string }>;
  setPassword(email: string, password: string): Promise<void>;
  /** The name mail shows beside the address; a Workspace user cannot change it themselves. */
  setName(email: string, givenName: string, familyName: string): Promise<void>;
  /**
   * The account's picture, set as the admin: no sign-in, so it works on an
   * inbox Google will not let us into. Still only (an animated GIF lands as
   * its first frame); the `google/profile-photo` flow keeps the animation.
   */
  setPhoto(email: string, image: Uint8Array, mimeType: "image/png" | "image/jpeg"): Promise<void>;
}

export class GoogleAdminError extends Error {
  readonly status: number;
  constructor(what: string, status: number, body: unknown) {
    const detail = (body as { error?: { message?: string } } | null)?.error?.message ?? "";
    super(`google admin ${what}: HTTP ${status} ${detail}`.trim());
    this.name = "GoogleAdminError";
    this.status = status;
  }
}

export function googleAdmin(opts: { token: TokenSupplier; http: HttpClient }): GoogleAdminClient {
  const call = <T>(
    what: string,
    url: string,
    init?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown },
  ) =>
    authedJson<T>(opts.http, opts.token, url, init).then((r) => {
      if (r.status === 404) return null;
      if (r.status >= 400) throw new GoogleAdminError(what, r.status, r.body);
      return r.body as T;
    });

  return {
    async getDomain(domain) {
      const d = await call<{ domainName: string; verified: boolean }>(
        "get domain",
        `${DIRECTORY}/customer/my_customer/domains/${encodeURIComponent(domain)}`,
      );
      return d ? { domainName: d.domainName, verified: d.verified } : null;
    },
    async addDomain(domain) {
      const d = await call<{ domainName: string; verified: boolean }>(
        "add domain",
        `${DIRECTORY}/customer/my_customer/domains`,
        { method: "POST", body: { domainName: domain } },
      );
      if (!d) throw new GoogleAdminError("add domain", 404, null);
      return { domainName: d.domainName, verified: d.verified };
    },
    async verificationToken(domain) {
      const r = await call<{ token: string }>("verification token", `${VERIFY}/token`, {
        method: "POST",
        body: { site: { type: "INET_DOMAIN", identifier: domain }, verificationMethod: "DNS_TXT" },
      });
      if (!r) throw new GoogleAdminError("verification token", 404, null);
      return r.token;
    },
    async verifyDomain(domain) {
      const r = await authedJson<{ id?: string; error?: { message?: string } }>(
        opts.http,
        opts.token,
        `${VERIFY}/webResource?verificationMethod=DNS_TXT`,
        { method: "POST", body: { site: { type: "INET_DOMAIN", identifier: domain } } },
      );
      if (r.status === 200) return true;
      // 400 = the record is not visible to Google yet; anything else is a real failure.
      if (r.status === 400) return false;
      throw new GoogleAdminError("verify domain", r.status, r.body);
    },
    async getUser(email) {
      return call<{ primaryEmail: string }>(
        "get user",
        `${DIRECTORY}/users/${encodeURIComponent(email)}`,
      );
    },
    async createUser(user) {
      const u = await call<{ primaryEmail: string }>("create user", `${DIRECTORY}/users`, {
        method: "POST",
        body: {
          primaryEmail: user.primaryEmail,
          name: { givenName: user.givenName, familyName: user.familyName },
          password: user.password,
          changePasswordAtNextLogin: false,
        },
      });
      if (!u) throw new GoogleAdminError("create user", 404, null);
      return u;
    },
    async setPassword(email, password) {
      const u = await call<{ primaryEmail: string }>(
        "set password",
        `${DIRECTORY}/users/${encodeURIComponent(email)}`,
        {
          method: "PUT",
          body: { password, changePasswordAtNextLogin: false },
        },
      );
      if (!u) throw new GoogleAdminError("set password", 404, null);
    },
    async setName(email, givenName, familyName) {
      const u = await call<{ primaryEmail: string }>(
        "set name",
        `${DIRECTORY}/users/${encodeURIComponent(email)}`,
        { method: "PUT", body: { name: { givenName, familyName } } },
      );
      if (!u) throw new GoogleAdminError("set name", 404, null);
    },
    async setPhoto(email, image, mimeType) {
      const u = await call<{ primaryEmail: string }>(
        "set photo",
        `${DIRECTORY}/users/${encodeURIComponent(email)}/photos/thumbnail`,
        { method: "PUT", body: { photoData: Buffer.from(image).toString("base64url"), mimeType } },
      );
      if (!u) throw new GoogleAdminError("set photo", 404, null);
    },
  };
}
