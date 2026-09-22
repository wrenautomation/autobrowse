import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCredentials, totp } from "credkeep";
import { describe, expect, it } from "vitest";
import { enrollTotpFlow, readSecretFromPage } from "../src/auth/enroll.js";
import type { FlowPage, Op } from "../src/browser/flow.js";
import type { Hints } from "../src/browser/locate.js";
import { NeedsHuman } from "../src/browser/session.js";

const SEED = "JBSWY3DPEHPK3PXP";

/** A page as a script: what the text and dialog say after each click. */
function fakePage(script: { text: string[]; html?: string; dialog?: string[] }) {
  const acts: Array<{ op: Op; hints: Hints }> = [];
  let i = 0;
  const at = (xs: string[]) => xs[Math.min(i, xs.length - 1)] ?? "";
  const page = {
    locator: () => ({
      first: () => ({ innerText: async () => at(script.dialog ?? []) }),
    }),
  } as unknown as FlowPage["page"];
  const fp: FlowPage = {
    page,
    async open() {},
    url: () => "https://site.test/2fa",
    text: async () => at(script.text),
    html: async () => script.html ?? "",
    has: async () => true,
    wait: async () => {},
    waitForUrl: async () => true,
    nextPage: async () => null,
    pages: () => [],
    switchTo() {},
    async act(op, hints) {
      acts.push({ op, hints });
      if (op.kind === "click") i++;
    },
    async signIn() {
      return "no-login" as const;
    },
    human(reason) {
      throw new NeedsHuman(reason);
    },
  };
  return { fp, acts };
}

const login = {
  site: "site",
  totpSetup: {
    url: "https://site.test/2fa",
    reveal: [
      { role: "button", name: "Set up" },
      { role: "button", name: "Can't scan" },
    ],
    toCode: [{ role: "button", name: "Next" }],
    code: { role: "textbox", name: "Code" },
    confirm: { role: "button", name: "Verify" },
    done: /authenticator added/i,
  },
};

function store() {
  const dir = mkdtempSync(join(tmpdir(), "enroll-"));
  return fileCredentials(join(dir, "c.json"));
}

describe("readSecretFromPage", () => {
  it("prefers the otpauth link in the HTML, then the dialog, then the page", async () => {
    const uri = fakePage({
      text: ["AAAA BBBB CCCC DDDD"],
      html: `<a href="otpauth://totp/X:a?secret=${SEED}">`,
    });
    expect(await readSecretFromPage(uri.fp)).toBe(SEED);
    const dialog = fakePage({
      text: ["AAAA BBBB CCCC DDDD"],
      dialog: ["Your key: JBSW Y3DP EHPK 3PXP"],
    });
    expect(await readSecretFromPage(dialog.fp)).toBe(SEED);
    const body = fakePage({ text: ["Key: JBSW Y3DP EHPK 3PXP"] });
    expect(await readSecretFromPage(body.fp)).toBe(SEED);
    expect(await readSecretFromPage(fakePage({ text: ["nothing here"] }).fp)).toBeNull();
  });
});

describe("enrollTotpFlow", () => {
  it("clicks to the seed, stores it, proves it with a code, checks the page confirmed", async () => {
    const s = store();
    await s.put("site", { username: "u", password: "p" });
    const { fp, acts } = fakePage({
      text: [
        "Set up your app",
        "Scan this",
        "Key: JBSW Y3DP EHPK 3PXP",
        "Enter code",
        "Authenticator added",
      ],
    });
    expect(await enrollTotpFlow(login, s).run(fp, undefined)).toBe("TOTP enrolled for site");
    expect((await s.get("site"))?.totpSecret).toBe(SEED);
    const fill = acts.find((a) => a.op.kind === "fill");
    expect(fill?.op.kind === "fill" && fill.op.value).toBe(totp(SEED));
    expect(acts.map((a) => a.hints.name)).toEqual([
      "Set up",
      "Can't scan",
      "Next",
      "Code",
      "Verify",
    ]);
  });
  it("stops at the first reveal step that shows the seed", async () => {
    const s = store();
    await s.put("site", { username: "u", password: "p" });
    const { fp, acts } = fakePage({
      text: ["Set up", "Key: JBSW Y3DP EHPK 3PXP", "Enter code", "Authenticator added"],
    });
    await enrollTotpFlow(login, s).run(fp, undefined);
    expect(acts.filter((a) => a.op.kind === "click").map((a) => a.hints.name)).toEqual([
      "Set up",
      "Next",
      "Verify",
    ]);
  });
  it("hands over when no seed ever shows; nothing stored", async () => {
    const s = store();
    await s.put("site", { username: "u", password: "p" });
    const { fp } = fakePage({ text: ["Set up", "Scan this", "still a QR"] });
    await expect(enrollTotpFlow(login, s).run(fp, undefined)).rejects.toThrow(NeedsHuman);
    expect((await s.get("site"))?.totpSecret).toBeUndefined();
  });
  it("reports when the page does not confirm, seed kept", async () => {
    const s = store();
    await s.put("site", { username: "u", password: "p" });
    const { fp } = fakePage({ text: ["Key: JBSW Y3DP EHPK 3PXP", "Enter code", "Wrong code"] });
    expect(await enrollTotpFlow(login, s).run(fp, undefined)).toMatch(
      /seed stored for site; page did not confirm/,
    );
    expect((await s.get("site"))?.totpSecret).toBe(SEED);
  });
  it("needs a setup page: the site's, or --url with the guessed walk", () => {
    expect(() => enrollTotpFlow({ site: "x" }, store())).toThrow(/pass --url/);
    expect(enrollTotpFlow({ site: "x" }, store(), "https://x.test/2fa").name).toBe("enroll-totp");
  });
});
