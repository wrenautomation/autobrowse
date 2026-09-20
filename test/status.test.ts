import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/app/config.js";
import { statusOf } from "../src/app/status.js";

describe("statusOf", () => {
  it("names vendors, channels and code sources without any value", () => {
    const settings = loadSettings({
      RESTATE_INGRESS_URL: "http://127.0.0.1:8080",
      LINQ_API_KEY: "k-secret-value",
      LINQ_NUMBER: "+15550009999",
      PHONE_NUMBER: "+15550001111",
      SENTRY_DSN: "https://x@o.ingest.sentry.io/1",
      PACE: "fast",
    });
    const s = statusOf(settings, { llm: "openai:gpt-5", memory: "memory", workflows: ["domain"] });
    expect(s.channels).toEqual(["phone", "linq"]);
    expect(s.codes).toEqual(["totp", "email", "sms:phone", "sms:linq"]);
    expect(s.sentry).toBe(true);
    expect(s.browser.pace).toBe("fast");
    expect(JSON.stringify(s)).not.toContain("k-secret-value");
  });
});
