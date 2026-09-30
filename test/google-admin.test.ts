import { describe, expect, it } from "vitest";
import { GoogleAdminError, googleAdmin } from "../src/clients/google-admin.js";
import type { HttpClient, JsonRequest } from "../src/clients/http.js";

/** A door that answers one canned response and keeps what it was asked. */
const door = (res: { status: number; body: unknown }) => {
  const calls: Array<{ url: string; req?: JsonRequest }> = [];
  const http: HttpClient = {
    json: async (url, req) => {
      calls.push({ url, ...(req ? { req } : {}) });
      return {
        status: res.status,
        ok: res.status < 400,
        body: res.body as never,
        headers: new Headers(),
      };
    },
  };
  return { http, calls };
};

describe("googleAdmin.setPhoto", () => {
  it("puts the picture as the admin, web-safe base64, no sign-in", async () => {
    const { http, calls } = door({ status: 200, body: { primaryEmail: "will@a.com" } });
    const admin = googleAdmin({ token: async () => "t", http });
    await admin.setPhoto("will@a.com", new Uint8Array([0xfb, 0xff, 0xfe]), "image/png");
    expect(calls[0]?.url).toBe(
      "https://admin.googleapis.com/admin/directory/v1/users/will%40a.com/photos/thumbnail",
    );
    expect(calls[0]?.req?.method).toBe("PUT");
    expect(calls[0]?.req?.body).toEqual({ photoData: "-__-", mimeType: "image/png" });
  });

  it("an inbox that is not in the Workspace is an error, not a quiet no-op", async () => {
    const { http } = door({ status: 404, body: null });
    const admin = googleAdmin({ token: async () => "t", http });
    await expect(admin.setPhoto("x@b.com", new Uint8Array([1]), "image/jpeg")).rejects.toThrow(
      GoogleAdminError,
    );
  });
});
