import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envFileStore } from "credvault";
import { describe, expect, it } from "vitest";
import { readDotenv } from "../src/app/config.js";

const DOTENV = ".env";

const file = (text: string) => {
  const f = join(mkdtempSync(join(tmpdir(), "dotenv-")), DOTENV);
  writeFileSync(f, text);
  return f;
};

describe("readDotenv", () => {
  it("reads export lines, drops inline comments and CR, unquotes padded values", () => {
    const got = readDotenv(
      file(
        [
          "# a comment",
          "export TOKEN_A=one",
          "TOKEN_B=two # why it is here",
          "TOKEN_C=three\r",
          'TOKEN_D="four"  ',
        ].join("\n"),
      ),
    );
    expect(Object.fromEntries(got)).toEqual({
      TOKEN_A: "one",
      TOKEN_B: "two",
      TOKEN_C: "three",
      TOKEN_D: "four",
    });
  });

  it("reads back what the env file store writes, a '#' in a value kept", async () => {
    const f = file("");
    await envFileStore(f, {}).put("SYNTH_PASS", "pa#ss=word");
    expect(readDotenv(f).get("SYNTH_PASS")).toBe("pa#ss=word");
  });

  it("is empty for a missing file", () => {
    expect(readDotenv(join(tmpdir(), "no-such-dir-xyz", DOTENV)).size).toBe(0);
  });
});
