import { describe, expect, it } from "vitest";
import { memoryCredentials } from "../src/auth/credentials.js";
import { newPassword, rotatePasswordFlow } from "../src/auth/rotate.js";
import type { FlowPage, Op } from "../src/browser/flow.js";
import type { Hints } from "../src/browser/locate.js";
import { NeedsHuman } from "../src/browser/session.js";

function fakePage(script: { text: string[]; present?: (h: Hints) => boolean; url?: string }) {
  const acts: Array<{ op: Op; hints: Hints }> = [];
  let i = 0;
  const fp: FlowPage = {
    page: {} as FlowPage["page"],
    async open() {},
    url: () => script.url ?? "https://site.test/password",
    text: async () => script.text[Math.min(i, script.text.length - 1)] ?? "",
    html: async () => "",
    has: async (h) => script.present?.(h) ?? true,
    wait: async () => {},
    waitForUrl: async () => true,
    nextPage: async () => null,
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
  passwordChange: {
    url: "https://site.test/password",
    current: { role: "textbox", name: "Current password" },
    next: { role: "textbox", name: "New password" },
    confirm: { role: "textbox", name: "Confirm" },
    submit: { role: "button", name: "Change" },
    done: /password changed/i,
  },
};

describe("newPassword", () => {
  it("is long, mixed, and free of look-alikes", () => {
    for (let n = 0; n < 50; n++) {
      const p = newPassword();
      expect(p).toHaveLength(24);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[!@#$%^&*\-_=+]/);
      expect(p).not.toMatch(/[lIO01]/);
    }
    expect(newPassword()).not.toBe(newPassword());
  });
});

describe("rotatePasswordFlow", () => {
  it("types the new password, stores it with the old as fallback, reports the confirmation", async () => {
    const store = memoryCredentials({ site: { username: "u", password: "old" } });
    const { fp, acts } = fakePage({ text: ["Change your password", "Password changed"] });
    const out = await rotatePasswordFlow(login, store, () => "NEW-pass-1234").run(fp, undefined);
    expect(out).toBe("password rotated for site");
    const cred = await store.get("site");
    expect(cred?.password).toBe("NEW-pass-1234");
    expect(cred?.previousPassword).toBe("old");
    expect(acts.map((a) => `${a.op.kind} ${a.hints.name}`)).toEqual([
      "fill Current password",
      "fill New password",
      "fill Confirm",
      "click Change",
    ]);
    const fills = acts
      .filter((a) => a.op.kind === "fill")
      .map((a) => (a.op.kind === "fill" ? a.op.value : ""));
    expect(fills).toEqual(["old", "NEW-pass-1234", "NEW-pass-1234"]);
  });
  it("keeps the old password when the site refuses the new one", async () => {
    const store = memoryCredentials({ site: { username: "u", password: "old" } });
    const { fp } = fakePage({ text: ["Change your password", "That password is too weak"] });
    await expect(rotatePasswordFlow(login, store, () => "x").run(fp, undefined)).rejects.toThrow(
      /refused the new password/,
    );
    expect((await store.get("site"))?.password).toBe("old");
    expect((await store.get("site"))?.previousPassword).toBeUndefined();
  });
  it("says so when the page neither confirms nor refuses; both passwords kept", async () => {
    const store = memoryCredentials({ site: { username: "u", password: "old" } });
    const { fp } = fakePage({ text: ["Change your password", "Something else"] });
    const out = await rotatePasswordFlow(login, store, () => "new").run(fp, undefined);
    expect(out).toMatch(/did not confirm/);
    expect((await store.get("site"))?.password).toBe("new");
    expect((await store.get("site"))?.previousPassword).toBe("old");
  });
  it("needs a known change-password page", () => {
    expect(() => rotatePasswordFlow({ site: "x" }, memoryCredentials())).toThrow(
      /no change-password/,
    );
  });
});
