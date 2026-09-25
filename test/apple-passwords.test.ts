import { describe, expect, it } from "vitest";
import { otpauthUri, passwordsCsv } from "../src/app/apple-passwords.js";

describe("Apple Passwords import", () => {
  it("writes Passwords' own columns, quoting what needs it", () => {
    const csv = passwordsCsv([
      {
        title: "Google (a@b.com)",
        url: "https://myaccount.google.com/",
        username: "a@b.com",
        password: 'p,"q',
        otpauth: otpauthUri("Google", "a@b.com", "JBSWY3DP"),
      },
    ]);
    expect(csv).toBe(
      `Title,URL,Username,Password,Notes,OTPAuth\nGoogle (a@b.com),https://myaccount.google.com/,a@b.com,"p,""q",,otpauth://totp/Google%3Aa%40b.com?secret=JBSWY3DP&issuer=Google\n`,
    );
  });
});
