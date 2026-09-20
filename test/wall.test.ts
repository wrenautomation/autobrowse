import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { looksLikeWall } from "../src/browser/session.js";

/** A page with only a URL and body text. */
const page = (url: string, text = "") =>
  ({
    url: () => url,
    locator: () => ({ innerText: async () => text }),
  }) as unknown as Page;

describe("looksLikeWall", () => {
  it("knows a sign-in URL from a settings page that mentions sign-in", async () => {
    expect(
      (await looksLikeWall(page("https://accounts.google.com/v3/signin/challenge/pwd")))?.kind,
    ).toBe("login");
    expect((await looksLikeWall(page("https://app.x.com/login")))?.kind).toBe("login");
    expect((await looksLikeWall(page("https://app.x.com/sign-in?next=/")))?.kind).toBe("login");
    expect(
      await looksLikeWall(page("https://myaccount.google.com/signinoptions/password")),
    ).toBeNull();
    expect(await looksLikeWall(page("https://x.com/settings/signin-methods"))).toBeNull();
  });
  it("reads captcha and challenge walls from the text", async () => {
    expect((await looksLikeWall(page("https://x.com/", "Verify you are human")))?.kind).toBe(
      "captcha",
    );
    expect((await looksLikeWall(page("https://x.com/", "Enter the code we sent")))?.kind).toBe(
      "challenge",
    );
    expect(await looksLikeWall(page("https://x.com/", "Dashboard"))).toBeNull();
    expect(
      await looksLikeWall(
        page(
          "https://x.com/signup",
          "Get set up\nThis site is protected by reCAPTCHA and the Google Privacy Policy",
        ),
      ),
    ).toBeNull();
    expect((await looksLikeWall(page("https://x.com/", "Complete the CAPTCHA below")))?.kind).toBe(
      "captcha",
    );
  });
});
