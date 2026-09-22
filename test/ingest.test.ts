import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCredentials } from "credkeep";
import { describe, expect, it } from "vitest";
import { ingest, parseCredentialLines, takeFile } from "../src/auth/ingest.js";

describe("credential ingest", () => {
  it("parses site lines, comments and a spaced authenticator key", () => {
    const lines = parseCredentialLines(
      "# scratch\ncloudflare a@x.co pw1\n\ngoogle-admin admin@x.co pw2 jbsw y3dp ehpk 3pxp\n",
    );
    expect(lines.map((l) => l.site)).toEqual(["cloudflare", "google-admin"]);
    expect(lines[1]?.cred.totpSecret).toBe("JBSWY3DPEHPK3PXP");
  });
  it("takes the site from the caller for a pasted line", () => {
    expect(parseCredentialLines("a@x.co pw", "instantly")[0]?.site).toBe("instantly");
  });
  it("reports a bad line by number only", () => {
    expect(() => parseCredentialLines("cloudflare onlyuser")).toThrow(/^line 1: expected/);
    expect(() => parseCredentialLines("ok a@x.co pw\nx a@x.co pw 123456")).toThrow(
      /^line 2: totpSecret/,
    );
  });
  it("stores every line", async () => {
    const store = memoryCredentials();
    expect(await ingest(store, parseCredentialLines("a u p\nb u p"))).toEqual(["a", "b"]);
    expect(await store.list()).toEqual(["a", "b"]);
  });
  it("shreds the scratch file after reading it", () => {
    const f = join(mkdtempSync(join(tmpdir(), "ingest-")), "creds.txt");
    writeFileSync(f, "a u p\n");
    expect(takeFile(f)).toBe("a u p\n");
    expect(existsSync(f)).toBe(false);
  });
});
