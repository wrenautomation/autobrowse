import { memoryCredentials } from "credvault";
import { describe, expect, it } from "vitest";
import { noCodes } from "../src/auth/codes.js";
import { oauthLogin, type SignInContext, signInContext } from "../src/auth/index.js";
import type { FlowPage } from "../src/browser/flow.js";
import type { Hints } from "../src/browser/locate.js";
import { fakePage } from "./auth-fakes.js";

/** Stops the sign-in right after credFor answers: the provider's own sign-in never runs. */
class Stop extends Error {}

/**
 * A page whose Google card is already open (One Tap), or opens after the
 * first click when `oneTap` is false; `credFor` records its account and stops.
 */
function ctxOf(cred: { username: string; password: string; via?: "google" }, oneTap = true) {
  const { fp: base, acts } = fakePage({ text: [""], present: () => true });
  const main = {} as FlowPage["page"];
  const card = { url: () => "https://accounts.google.com/v3/signin" } as FlowPage["page"];
  const fp: FlowPage = {
    ...base,
    page: main,
    pages: () => (oneTap || acts.length ? [main, card] : [main]),
  };
  const asked: Array<[string, string | undefined]> = [];
  const ctx = {
    fp,
    cred: { recoveryCodes: [], passkeys: [], ...cred },
    async credFor(site: string, account?: string) {
      asked.push([site, account]);
      throw new Stop();
    },
    as: () => ctx,
  } as unknown as SignInContext;
  return { ctx, asked, acts };
}

const spec = { start: "https://www.perplexity.ai/", success: /perplexity\.ai/ };

describe("oauth sign-in account", () => {
  it("a site made via the provider signs in as its own username there", async () => {
    const { ctx, asked } = ctxOf({ username: "wren@wren.test", password: "p", via: "google" });
    await expect(oauthLogin("perplexity", spec)(ctx)).rejects.toBeInstanceOf(Stop);
    expect(asked).toEqual([["google", "wren@wren.test"]]);
  });

  it("without via, the provider's stored default", async () => {
    const { ctx, asked } = ctxOf({ username: "wren@wren.test", password: "p" });
    await expect(oauthLogin("perplexity", spec)(ctx)).rejects.toBeInstanceOf(Stop);
    expect(asked).toEqual([["google", undefined]]);
  });

  it("the spec's account wins over the credential's", async () => {
    const { ctx, asked } = ctxOf({ username: "wren@wren.test", password: "p", via: "google" });
    await expect(
      oauthLogin("perplexity", { ...spec, account: "ops@wren.test" })(ctx),
    ).rejects.toBeInstanceOf(Stop);
    expect(asked).toEqual([["google", "ops@wren.test"]]);
  });

  it("clicks `before` ahead of the provider's button", async () => {
    const { ctx, acts } = ctxOf({ username: "w@wren.test", password: "p", via: "google" }, false);
    const open: Hints = { role: "button", name: "Sign In" };
    const button: Hints = { role: "button", name: "Continue with Google" };
    await expect(
      oauthLogin("perplexity", { ...spec, before: [open], button })(ctx),
    ).rejects.toBeInstanceOf(Stop);
    expect(acts.map((a) => a.hints)).toEqual([open, button]);
  });
});

describe("provider credential by account", () => {
  it("finds a <provider>@<label> credential whose username matches, never <provider>-<x>", async () => {
    const { fp } = fakePage({ text: [""], present: () => false });
    const credentials = memoryCredentials({
      perplexity: { username: "admin@wren.test", password: "p", via: "google" },
      google: { username: "will@wren.test", password: "g" },
      "google@admin": { username: "admin@wren.test", password: "a" },
      "google-wren": { username: "dup@wren.test", password: "d" },
      "google@ops": { username: "ops@wren.test", password: "o" },
      "googleish-x": { username: "x@wren.test", password: "x" },
    });
    const cred = (await credentials.get("perplexity")) as never;
    const ctx = signInContext({ fp, site: "perplexity", cred, credentials, codes: noCodes });
    expect((await ctx.credFor("google", "admin@wren.test")).password).toBe("a");
    expect((await ctx.credFor("google", "ops@wren.test")).password).toBe("o");
    expect((await ctx.credFor("google", "will@wren.test")).password).toBe("g");
    await expect(ctx.credFor("google", "x@wren.test")).rejects.toThrow(/no google credential/);
    await expect(ctx.credFor("google", "dup@wren.test")).rejects.toThrow(/no google credential/);
  });
});
