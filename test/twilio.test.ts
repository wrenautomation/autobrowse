import { describe, expect, it } from "vitest";
import { httpClient } from "../src/clients/http.js";
import { twilioReader } from "../src/clients/twilio.js";

describe("twilioReader", () => {
  it("lists recent messages for our number, auth in the header, newest first", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const http = httpClient({
      fetch: async (url, init) => {
        seen.push({ url, auth: new Headers(init?.headers).get("authorization") ?? undefined });
        return new Response(
          JSON.stringify({
            messages: [
              {
                from: "+1555",
                body: "Your code is 111111",
                date_sent: "2026-09-19T10:00:00Z",
                date_created: "",
              },
              {
                from: "+1555",
                body: "Your code is 222222",
                date_sent: "2026-09-19T12:00:00Z",
                date_created: "",
              },
              {
                from: "+1555",
                body: "old 333333",
                date_sent: "2026-09-18T12:00:00Z",
                date_created: "",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const reader = twilioReader({ accountSid: "ACxyz", authToken: "tok-secret", http });
    const out = await reader.recent("+15550001111", new Date("2026-09-19T00:00:00Z"));
    expect(out.map((m) => m.text)).toEqual(["Your code is 222222", "Your code is 111111"]);
    expect(seen[0]?.url).not.toContain("tok-secret");
    expect(seen[0]?.url).toContain("To=%2B15550001111");
    expect(seen[0]?.auth).toMatch(/^Basic /);
  });
});
