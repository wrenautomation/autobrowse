import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActOptions, FlowPage, Op } from "../src/browser/flow.js";
import {
  OLD,
  redditComment,
  redditRead,
  redditSubmit,
  slimListing,
} from "../src/browser/flows/reddit.js";
import type { Hints } from "../src/browser/locate.js";
import { NeedsHuman } from "../src/browser/session.js";

/** A DOM element as the page scripts read it. */
type El = {
  className: string;
  textContent: string | null;
  offsetParent: El | null;
  id: string;
  getAttribute(name: string): string | null;
  querySelectorAll(sel: string): El[];
};
const el = (o: {
  cls?: string;
  text?: string;
  hidden?: boolean;
  id?: string;
  attrs?: Record<string, string>;
}): El => ({
  className: o.cls ?? "",
  textContent: o.text ?? "",
  offsetParent: o.hidden ? null : ({} as El),
  id: o.id ?? "",
  getAttribute: (n) => o.attrs?.[n] ?? null,
  querySelectorAll: () => [],
});
const comment = (fullname: string, author: string, withAttr = true) =>
  el({
    id: `thing_${fullname}`,
    attrs: withAttr
      ? { "data-author": author, "data-fullname": fullname }
      : { "data-author": author },
  });

type Act = { op: Op; hints: Hints; opts: ActOptions };
type Answer = { status: number; body?: unknown };

/**
 * A fake old.reddit page: `page.evaluate` runs the flow's own page script
 * against a stubbed `document` and `fetch`, so the DOM parsing is tested too.
 */
function redditPage(o: {
  url?: string;
  present?: (h: Hints) => boolean;
  fetch?: (url: string) => Answer;
  dom?: (sel: string) => El[];
  srValue?: string;
  captcha?: { solved: boolean; reason?: string };
  onAct?: (a: Act, page: { go: (u: string) => void }) => void;
}) {
  let url = o.url ?? "about:blank";
  const acts: Act[] = [];
  const opens: string[] = [];
  const fetched: Array<{ url: string; init: unknown }> = [];
  const locators: string[] = [];
  let waits = 0;
  const go = (u: string) => {
    url = u;
  };
  vi.stubGlobal("document", {
    querySelectorAll: (sel: string) => o.dom?.(sel) ?? [],
  });
  vi.stubGlobal("fetch", async (u: string, init: unknown) => {
    fetched.push({ url: u, init });
    const a = o.fetch?.(u) ?? { status: 200, body: {} };
    return {
      status: a.status,
      ok: a.status >= 200 && a.status < 300,
      json: async () => a.body,
    };
  });
  const page = {
    evaluate: async (fn: (arg: unknown) => unknown, arg?: unknown) => fn(arg),
    locator: (sel: string) => {
      locators.push(sel);
      return { inputValue: async () => o.srValue ?? "" };
    },
  };
  const fp: FlowPage = {
    page: page as unknown as FlowPage["page"],
    passkeys: {} as FlowPage["passkeys"],
    captcha: async () =>
      ({
        solved: o.captcha?.solved ?? false,
        kind: null,
        vendor: null,
        reason: o.captcha?.reason ?? "fake",
      }) as never,
    async open(u, opts) {
      opens.push(opts?.allowWall ? `${u} (wall ok)` : u);
      url = u;
    },
    url: () => url,
    text: async () => "",
    html: async () => "",
    has: async (h) => o.present?.(h) ?? false,
    read: async () => "",
    wait: async () => {
      waits++;
    },
    answer: async () => {},
    waitForUrl: async (p) => (p instanceof RegExp ? p.test(url) : p(url)),
    nextPage: async () => null,
    scroll: async () => {},
    pages: () => [],
    switchTo() {},
    async act(op, hints, opts) {
      const a = { op, hints, opts };
      acts.push(a);
      o.onAct?.(a, { go });
    },
    async signIn() {
      return "no-login";
    },
    human(reason) {
      throw new NeedsHuman(reason);
    },
  };
  return { fp, acts, opens, fetched, locators, waits: () => waits };
}

const line = (a: Act) => {
  const target = a.hints.css ?? `${a.hints.role}:${a.hints.name}`;
  if (a.op.kind === "fill") return `fill ${target}=${a.op.value}`;
  if (a.op.kind === "press") return `press ${target} ${a.op.key}`;
  return `${a.op.kind} ${target}`;
};

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slimListing", () => {
  it("keeps the caller's fields per thing and drops the modhash", () => {
    const out = slimListing({
      kind: "Listing",
      data: {
        modhash: "SECRET",
        dist: 2,
        after: "t3_b",
        children: [
          {
            kind: "t3",
            data: { id: "a", name: "t3_a", title: "hi", score: 3, modhash: "SECRET", likes: true },
          },
          "junk",
          null,
          [1],
          { kind: "t1", data: { id: "c", body: "yo", link_id: "t3_a", gilded: 1 } },
        ],
      },
    });
    expect(out).toEqual({
      kind: "Listing",
      data: {
        after: "t3_b",
        before: null,
        children: [
          { kind: "t3", data: { id: "a", name: "t3_a", title: "hi", score: 3 } },
          { kind: "t1", data: { id: "c", body: "yo", link_id: "t3_a" } },
        ],
      },
    });
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("anything else is an empty listing", () => {
    const empty = { kind: "Listing", data: { after: null, before: null, children: [] } };
    for (const junk of [null, undefined, "x", 3, [], { data: null }, { data: { children: "x" } }])
      expect(slimListing(junk)).toEqual(empty);
    // A thing whose data is not an object keeps its kind, with nothing picked.
    expect(slimListing({ data: { children: [{ kind: "t3", data: "x" }] } })).toMatchObject({
      data: { children: [{ kind: "t3", data: {} }] },
    });
  });
});

describe("reddit/read", () => {
  it("fetches the page's .json twin from inside old.reddit, with the session's cookies", async () => {
    const p = redditPage({
      fetch: () => ({ status: 200, body: { kind: "Listing", data: { children: [] } } }),
    });
    await redditRead.run(p.fp, {
      path: "/user/WrenAutomation/submitted",
      query: { limit: 5, sort: "new" },
    });
    // Not on old.reddit yet: opened first, so the fetch is same origin.
    expect(p.opens).toEqual([`${OLD}/`]);
    expect(p.fetched).toHaveLength(1);
    const u = new URL(p.fetched[0]?.url ?? "");
    expect(u.origin + u.pathname).toBe(`${OLD}/user/WrenAutomation/submitted.json`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ limit: "5", sort: "new", raw_json: "1" });
    expect(p.fetched[0]?.init).toMatchObject({ credentials: "include" });
  });

  it("stays on the page when already on old.reddit", async () => {
    const p = redditPage({ url: `${OLD}/r/startups/`, fetch: () => ({ status: 200, body: {} }) });
    await redditRead.run(p.fp, { path: "/api/info", query: { id: "t3_a" } });
    expect(p.opens).toEqual([]);
    expect(p.fetched[0]?.url).toBe(`${OLD}/api/info.json?id=t3_a&raw_json=1`);
  });

  it("refuses a path it does not serve, before any fetch", async () => {
    for (const path of [
      "/api/v1/me",
      "/api/me/",
      "/user/ab/submitted",
      "/user/WrenAutomation/saved",
      "/user/Wren Automation/submitted",
      "/comments/ABC",
      "/comments/abc/title",
      "/r/x/about/rules",
      "/r/startups/about/rules.json",
      "/api/submit",
    ]) {
      const p = redditPage({});
      await expect(redditRead.run(p.fp, { path })).rejects.toThrow(/not a read this flow serves/);
      expect(p.fetched).toEqual([]);
    }
  });

  it("the account: its own fields only, never the modhash or prefs", async () => {
    const p = redditPage({
      fetch: () => ({
        status: 200,
        body: {
          kind: "t2",
          data: {
            id: "abc",
            name: "WrenAutomation",
            link_karma: 1,
            comment_karma: 2,
            total_karma: 3,
            created_utc: 1,
            has_verified_email: true,
            modhash: "SECRET",
            pref_nightmode: true,
            features: { x: 1 },
          },
        },
      }),
    });
    const out = await redditRead.run(p.fp, { path: "/api/me" });
    expect(out).toEqual({
      id: "abc",
      name: "WrenAutomation",
      link_karma: 1,
      comment_karma: 2,
      total_karma: 3,
      created_utc: 1,
      has_verified_email: true,
    });
  });

  it("signed out (/api/me with no name) goes to a person", async () => {
    const p = redditPage({ fetch: () => ({ status: 200, body: { data: {} } }) });
    await expect(redditRead.run(p.fp, { path: "/api/me" })).rejects.toThrow(NeedsHuman);
    const q = redditPage({ fetch: () => ({ status: 200, body: {} }) });
    await expect(redditRead.run(q.fp, { path: "/api/me" })).rejects.toThrow(/signed out/);
  });

  it("a post's comments: the two listings, slimmed", async () => {
    const listing = (id: string) => ({
      kind: "Listing",
      data: { modhash: "SECRET", children: [{ kind: "t3", data: { id, extra: 1 } }] },
    });
    const p = redditPage({
      fetch: () => ({ status: 200, body: [listing("a"), listing("b"), listing("c")] }),
    });
    const out = (await redditRead.run(p.fp, { path: "/comments/abc123" })) as unknown[];
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      kind: "Listing",
      data: { after: null, before: null, children: [{ kind: "t3", data: { id: "b" } }] },
    });
    // A single listing (not the usual pair) is slimmed as one.
    const q = redditPage({ fetch: () => ({ status: 200, body: listing("z") }) });
    expect(await redditRead.run(q.fp, { path: "/comments/abc123" })).toMatchObject({
      kind: "Listing",
    });
  });

  it("a subreddit's rules: the rule fields, [] when absent", async () => {
    const p = redditPage({
      fetch: () => ({
        status: 200,
        body: {
          rules: [
            {
              short_name: "No spam",
              description: "d",
              kind: "all",
              violation_reason: "Spam",
              priority: 0,
              created_utc: 1,
              description_html: "<p>d</p>",
            },
          ],
          site_rules: ["x"],
        },
      }),
    });
    expect(await redditRead.run(p.fp, { path: "/r/startups/about/rules" })).toEqual({
      rules: [
        {
          short_name: "No spam",
          description: "d",
          kind: "all",
          violation_reason: "Spam",
          priority: 0,
        },
      ],
    });
    const q = redditPage({ fetch: () => ({ status: 200, body: {} }) });
    expect(await redditRead.run(q.fp, { path: "/r/startups/about/rules" })).toEqual({ rules: [] });
  });

  it("an account's card keeps its follower count; signed out it lands on www past the sign-up rail", async () => {
    const p = redditPage({
      fetch: () => ({
        status: 200,
        body: {
          data: { name: "acme", total_karma: 3, subreddit: { subscribers: 12, title: "x" } },
        },
      }),
    });
    expect(await redditRead.run(p.fp, { path: "/user/acme/about", signedOut: true })).toEqual({
      name: "acme",
      total_karma: 3,
      followers: 12,
    });
    expect(p.opens).toEqual(["https://www.reddit.com/ (wall ok)"]);
    const q = redditPage({ fetch: () => ({ status: 200, body: { data: { name: "acme" } } }) });
    expect(await redditRead.run(q.fp, { path: "/user/acme/about" })).toEqual({ name: "acme" });
    expect(q.opens).toEqual(["https://old.reddit.com/"]);
  });

  it("404 is an answer; any other failure throws", async () => {
    const p = redditPage({ fetch: () => ({ status: 404 }) });
    expect(await redditRead.run(p.fp, { path: "/comments/zzz" })).toEqual({
      error: 404,
      message: "no such thing: /comments/zzz",
    });
    const q = redditPage({ fetch: () => ({ status: 500 }) });
    await expect(redditRead.run(q.fp, { path: "/comments/zzz" })).rejects.toThrow(/HTTP 500/);
    const r = redditPage({ fetch: () => ({ status: 403 }) });
    await expect(redditRead.run(r.fp, { path: "/api/me" })).rejects.toThrow(/HTTP 403/);
  });
});

const SUBMIT_BUTTON = { css: "#newlink button[name=submit]" };
const POST = `${OLD}/r/startups/comments/abc123/hello_world/`;

/** A submit page whose form is there; the post button lands on `landAt` (null: stays put). */
function submitPage(
  o: {
    srValue?: string;
    landAt?: string | null;
    captcha?: boolean;
    captchaSolved?: boolean;
    errors?: El[];
    form?: boolean;
    me?: string;
  } = {},
) {
  return redditPage({
    present: (h) => {
      if (h.css === "textarea[name=title]") return o.form ?? true;
      if (h.css === 'iframe[src*="recaptcha"]') return o.captcha ?? false;
      return true;
    },
    srValue: o.srValue ?? "startups",
    captcha: { solved: o.captchaSolved ?? false, reason: "picture captcha" },
    dom: (sel) =>
      sel === "form .error"
        ? (o.errors ?? [])
        : sel === "#header .user a"
          ? [el({ text: o.me ?? "WrenAutomation" })]
          : [],
    onAct: (a, page) => {
      if (a.hints.css === SUBMIT_BUTTON.css && o.landAt !== null) page.go(o.landAt ?? POST);
    },
  });
}

describe("reddit/submit", () => {
  it("a text post into a subreddit: fills, closes the suggestions, checks the field, posts", async () => {
    const p = submitPage();
    const out = await redditSubmit.run(p.fp, {
      sr: "startups",
      title: "Hello",
      kind: "self",
      text: "Body",
    });
    expect(p.opens).toEqual([`${OLD}/submit?selftext=true`]);
    expect(p.acts.map(line)).toEqual([
      "fill textarea[name=title]=Hello",
      "fill textarea[name=text]=Body",
      "fill input[name=sr]=startups",
      "press input[name=sr] Escape",
      "click #newlink button[name=submit]",
    ]);
    expect(p.locators).toEqual(["input[name=sr]"]);
    expect(out).toEqual({
      json: {
        errors: [],
        data: {
          id: "abc123",
          name: "t3_abc123",
          url: "https://www.reddit.com/r/startups/comments/abc123/hello_world/",
        },
      },
    });
  });

  it("an image post goes to www's composer, uploads, and stops before Post when dry", async () => {
    const p = submitPage();
    const out = await redditSubmit.run(p.fp, {
      sr: "test",
      title: "T",
      kind: "image",
      image: "/tmp/a.png",
      text: "Body",
      dry: true,
    });
    expect(p.opens).toEqual(["https://www.reddit.com/r/test/submit/?type=IMAGE"]);
    expect(p.acts.map(line)).toEqual([
      "fill textbox:Title=T",
      "upload post-composer-toolbar-button-image input[type=file]",
      "fill textbox:Post body text field=Body",
    ]);
    expect(out).toEqual({
      json: {
        errors: [],
        data: { id: "", name: "", url: "https://www.reddit.com/r/test", dry: true },
      },
    });
  });

  it("an image post sends with Post, the one irreversible act", async () => {
    const p = redditPage({
      present: () => true,
      onAct: (a, page) => {
        if (a.hints.name === "Post") page.go(POST);
      },
    });
    const out = await redditSubmit.run(p.fp, {
      sr: "startups",
      title: "T",
      kind: "image",
      image: "/tmp/a.png",
    });
    expect(p.acts.filter((a) => a.opts.irreversible).map(line)).toEqual(["click button:Post"]);
    expect(out).toMatchObject({ json: { errors: [], data: { id: "abc123", name: "t3_abc123" } } });
  });

  it("refuses an image post with no image, and dry on anything but an image", async () => {
    const p = submitPage();
    expect(await redditSubmit.run(p.fp, { sr: "test", title: "T", kind: "image" })).toMatchObject({
      json: { errors: [["NO_IMAGE", expect.any(String), "image"]] },
    });
    expect(
      await redditSubmit.run(p.fp, { sr: "test", title: "T", kind: "self", dry: true }),
    ).toMatchObject({ json: { errors: [["DRY_UNSUPPORTED", expect.any(String), "dry"]] } });
    expect(p.acts).toEqual([]);
  });

  it("only the post button is irreversible", async () => {
    const p = submitPage();
    await redditSubmit.run(p.fp, { sr: "startups", title: "T", kind: "self" });
    expect(p.acts.filter((a) => a.opts.irreversible).map(line)).toEqual([
      "click #newlink button[name=submit]",
    ]);
  });

  it("regression: the click is pinned to the post form, never the header search's submit input", async () => {
    // old.reddit's header search has an unlabeled `input[type=submit]` that also reads "Submit":
    // a role/name locator would hit whichever comes first in the DOM. Only a scoped css is safe.
    const p = submitPage();
    await redditSubmit.run(p.fp, { sr: "startups", title: "T", kind: "self" });
    const post = p.acts.find((a) => a.opts.irreversible);
    expect(post?.hints).toEqual(SUBMIT_BUTTON);
    expect(post?.hints.role).toBeUndefined();
    expect(post?.hints.name).toBeUndefined();
    expect(post?.hints.text).toBeUndefined();
    expect(post?.hints.css).toMatch(/^#newlink\b/);
  });

  it("a link post opens the link form and types the url first; no body", async () => {
    const p = submitPage();
    await redditSubmit.run(p.fp, {
      sr: "startups",
      title: "Look",
      kind: "link",
      url: "https://wrenautomation.com",
      text: "ignored",
    });
    expect(p.opens).toEqual([`${OLD}/submit`]);
    expect(p.acts.map(line).slice(0, 2)).toEqual([
      "fill #url=https://wrenautomation.com",
      "fill textarea[name=title]=Look",
    ]);
    expect(p.acts.map(line)).not.toContain("fill textarea[name=text]=ignored");
  });

  it("a self post with no text types no body", async () => {
    const p = submitPage();
    await redditSubmit.run(p.fp, { sr: "startups", title: "T", kind: "self" });
    expect(p.acts.some((a) => a.hints.css === "textarea[name=text]")).toBe(false);
  });

  it("the profile (u_ or u/) clicks Your profile, types no subreddit, checks no field", async () => {
    for (const sr of ["u_WrenAutomation", "u/WrenAutomation", "U_WrenAutomation"]) {
      const p = submitPage({ srValue: "whatever" });
      const out = await redditSubmit.run(p.fp, { sr, title: "T", kind: "self" });
      expect(p.acts.map(line)).toEqual([
        "fill textarea[name=title]=T",
        "click radio:Your profile",
        "click #newlink button[name=submit]",
      ]);
      expect(p.locators).toEqual([]);
      expect(out.json.data?.name).toBe("t3_abc123");
    }
  });

  it("a profile sr naming another account is refused, not posted to the signed-in profile", async () => {
    const p = submitPage();
    const out = await redditSubmit
      .run(p.fp, { sr: "u_SomeoneElse", title: "T", kind: "self" })
      .catch((e: unknown) => e);
    expect(p.acts.some((a) => a.opts.irreversible)).toBe(false);
    expect(out).not.toMatchObject({ json: { errors: [] } });
  });

  it("a suggestion taken by mistake goes to a person before the post button", async () => {
    const p = submitPage({ srValue: "startups_uk" });
    await expect(
      redditSubmit.run(p.fp, { sr: "startups", title: "T", kind: "self" }),
    ).rejects.toThrow(/subreddit field says "startups_uk", not "startups"/);
    expect(p.acts.some((a) => a.opts.irreversible)).toBe(false);
    // Case is not a mismatch.
    const q = submitPage({ srValue: "Startups" });
    await expect(
      redditSubmit.run(q.fp, { sr: "startups", title: "T", kind: "self" }),
    ).resolves.toMatchObject({ json: { errors: [] } });
  });

  it("sendreplies false unticks the inbox box; true or absent leaves it", async () => {
    const p = submitPage();
    await redditSubmit.run(p.fp, { sr: "startups", title: "T", kind: "self", sendreplies: false });
    expect(p.acts.map(line)).toContain("click checkbox:send replies to my inbox");
    for (const sendreplies of [true, undefined]) {
      const q = submitPage();
      await redditSubmit.run(q.fp, { sr: "startups", title: "T", kind: "self", sendreplies });
      expect(q.acts.some((a) => a.hints.role === "checkbox")).toBe(false);
    }
  });

  it("a flair id alone is refused in Reddit's envelope before the page opens", async () => {
    const p = submitPage();
    const out = await redditSubmit.run(p.fp, {
      sr: "startups",
      title: "T",
      kind: "self",
      flair_id: "f1",
    });
    expect(out).toEqual({
      json: {
        errors: [["FLAIR_UNSUPPORTED", "the browser leg picks a flair by its text", "flair"]],
      },
    });
    expect(p.opens).toEqual([]);
    expect(p.acts).toEqual([]);
  });

  it("marks NSFW, spoiler and the flair on the landed post, after the post button", async () => {
    const p = submitPage();
    const out = await redditSubmit.run(p.fp, {
      sr: "startups",
      title: "T",
      kind: "self",
      nsfw: true,
      spoiler: true,
      flair_text: "Feedback",
    });
    const after = p.acts.map(line).slice(p.acts.findIndex((a) => a.opts.irreversible) + 1);
    expect(after).toEqual([
      "click #thing_t3_abc123 .marknsfw-button a",
      "click #thing_t3_abc123 .marknsfw-button .yes",
      "click #thing_t3_abc123 .spoiler-button a",
      "click #thing_t3_abc123 .spoiler-button .yes",
      "click #thing_t3_abc123 .flairselectbtn",
      "click .flairselector li",
      "click .flairselector button[type=submit]",
    ]);
    expect(out.json.data?.notes).toBeUndefined();
  });

  it("a mark it can't find is a note on the posted answer, not a failure", async () => {
    const p = redditPage({
      present: (h) => !/flairselectbtn|recaptcha/.test(String(h.css ?? "")),
      srValue: "startups",
      captcha: { solved: false, reason: "picture captcha" },
      dom: (sel) => (sel === "#header .user a" ? [el({ text: "WrenAutomation" })] : []),
      onAct: (a, page) => {
        if (a.hints.css === SUBMIT_BUTTON.css) page.go(POST);
      },
    });
    const out = await redditSubmit.run(p.fp, {
      sr: "startups",
      title: "T",
      kind: "self",
      flair_text: "Feedback",
    });
    expect(out.json.data?.id).toBe("abc123");
    expect(out.json.data?.notes).toEqual([
      'Posted, but couldn\'t set the flair "Feedback": set it on the post.',
    ]);
  });

  it("no form goes to a person before any act", async () => {
    const p = submitPage({ form: false });
    await expect(
      redditSubmit.run(p.fp, { sr: "startups", title: "T", kind: "self" }),
    ).rejects.toThrow(/no submit form/);
    expect(p.acts).toEqual([]);
  });

  it("a captcha is solved just before the post button; an unsolved one goes to a person", async () => {
    const ok = submitPage({ captcha: true, captchaSolved: true });
    await expect(
      redditSubmit.run(ok.fp, { sr: "startups", title: "T", kind: "self" }),
    ).resolves.toMatchObject({ json: { errors: [] } });
    const stuck = submitPage({ captcha: true, captchaSolved: false });
    await expect(
      redditSubmit.run(stuck.fp, { sr: "startups", title: "T", kind: "self" }),
    ).rejects.toThrow(/captcha is a person's \(picture captcha\)/);
    expect(stuck.acts.some((a) => a.opts.irreversible)).toBe(false);
    expect(stuck.acts).toHaveLength(3);
  });

  it("refused: the visible errors as [code, message, field] triples", async () => {
    const p = submitPage({
      landAt: null,
      errors: [
        el({
          cls: "error SUBREDDIT_NOEXIST field-sr",
          text: "  Hmm, that community doesn't exist ",
        }),
        el({ cls: "error RATELIMIT field-ratelimit", text: "take a break", hidden: true }),
        el({ cls: "error NO_TEXT field-title", text: "   " }),
        el({ cls: "error", text: "something went wrong" }),
      ],
    });
    const out = await redditSubmit.run(p.fp, { sr: "startups", title: "T", kind: "self" });
    expect(out).toEqual({
      json: {
        errors: [
          ["SUBREDDIT_NOEXIST", "Hmm, that community doesn't exist", "sr"],
          ["REFUSED", "something went wrong", ""],
        ],
      },
    });
  });

  it("neither landed nor refused goes to a person", async () => {
    const p = submitPage({ landAt: null });
    await expect(
      redditSubmit.run(p.fp, { sr: "startups", title: "T", kind: "self" }),
    ).rejects.toThrow(/neither landed on the post nor said why/);
  });

  it("the landed id is the /comments/<id> segment, on a bare URL too", async () => {
    const p = submitPage({ landAt: `${OLD}/comments/9z` });
    const out = await redditSubmit.run(p.fp, { sr: "startups", title: "T", kind: "self" });
    expect(out.json.data).toEqual({
      id: "9z",
      name: "t3_9z",
      url: "https://www.reddit.com/comments/9z",
    });
  });
});

/** A post or comment page: `/api/info` answers `permalink`; the save adds `made` to the page. */
function commentPage(o: {
  thing: string;
  permalink?: string | null;
  reply?: boolean;
  form?: boolean;
  existing?: El[];
  made?: El[];
  errors?: El[];
  me?: string;
  captcha?: boolean;
}) {
  let saved = false;
  const p = redditPage({
    fetch: (u) => {
      const id = new URL(u).searchParams.get("id");
      if (o.permalink === null || id !== o.thing) return { status: 200, body: { data: {} } };
      return {
        status: 200,
        body: {
          kind: "Listing",
          data: { children: [{ kind: o.thing.slice(0, 2), data: { permalink: o.permalink } }] },
        },
      };
    },
    present: (h) => {
      if (h.css === 'iframe[src*="recaptcha"]') return o.captcha ?? false;
      if (h.css?.includes("a[onclick*=reply]")) return o.reply ?? true;
      if (h.css?.includes("textarea[name=text]")) return o.form ?? true;
      return true;
    },
    captcha: { solved: true },
    dom: (sel) => {
      if (sel === "#header .user a")
        return o.me === "" ? [] : [el({ text: o.me ?? "WrenAutomation" })];
      if (sel === ".thing.comment")
        return [...(o.existing ?? []), ...(saved ? (o.made ?? []) : [])];
      if (sel.endsWith(" .error")) return saved ? (o.errors ?? []) : [];
      return [];
    },
    onAct: (a) => {
      if (a.opts.irreversible) saved = true;
    },
  });
  return p;
}

describe("reddit/comment", () => {
  it("a top-level comment on a post: finds it, types in the post's own form, answers with the new t1", async () => {
    const p = commentPage({
      thing: "t3_abc",
      permalink: "/r/startups/comments/abc/hello/",
      existing: [comment("t1_old", "WrenAutomation"), comment("t1_x", "someone")],
      made: [comment("t1_theirs", "someone"), comment("t1_new", "WrenAutomation")],
    });
    const out = await redditComment.run(p.fp, { thing_id: "t3_abc", text: "Nice" });
    expect(p.fetched[0]?.url).toBe(`${OLD}/api/info.json?id=t3_abc&raw_json=1`);
    expect(p.opens).toEqual([`${OLD}/`, `${OLD}/r/startups/comments/abc/hello/`]);
    expect(p.acts.map(line)).toEqual([
      "fill .commentarea > form.usertext textarea[name=text]=Nice",
      "click .commentarea > form.usertext button[type=submit]",
    ]);
    expect(p.acts.filter((a) => a.opts.irreversible)).toHaveLength(1);
    expect(p.acts[1]?.opts.irreversible).toBe(true);
    expect(out).toEqual({
      json: { errors: [], data: { things: [{ kind: "t1", data: { id: "new", name: "t1_new" } }] } },
    });
  });

  it("a reply to a comment opens its reply box and types inside the comment's .child", async () => {
    const p = commentPage({
      thing: "t1_c1",
      permalink: "/r/startups/comments/abc/hello/c1/",
      made: [comment("t1_r1", "WrenAutomation")],
    });
    const out = await redditComment.run(p.fp, { thing_id: "t1_c1", text: "Thanks" });
    expect(p.acts.map(line)).toEqual([
      "click #thing_t1_c1 > .entry a[onclick*=reply]",
      "fill #thing_t1_c1 > .child textarea[name=text]=Thanks",
      "click #thing_t1_c1 > .child button[type=submit]",
    ]);
    expect(p.acts.map((a) => a.opts.irreversible ?? false)).toEqual([false, false, true]);
    expect(out.json.data?.things).toEqual([{ kind: "t1", data: { id: "r1", name: "t1_r1" } }]);
  });

  it("a new comment without data-fullname is read off its element id", async () => {
    const p = commentPage({
      thing: "t3_abc",
      permalink: "/r/x/comments/abc/t/",
      made: [comment("t1_byid", "WrenAutomation", false)],
    });
    const out = await redditComment.run(p.fp, { thing_id: "t3_abc", text: "hi" });
    expect(out.json.data?.things).toEqual([{ kind: "t1", data: { id: "byid", name: "t1_byid" } }]);
  });

  it("refuses a bad id before any fetch", async () => {
    for (const thing_id of ["t2_abc", "abc", "t3_", "t1_ABC", "t3_abc,t1_def"]) {
      const p = commentPage({ thing: "t3_abc", permalink: "/x/" });
      expect(await redditComment.run(p.fp, { thing_id, text: "hi" })).toEqual({
        json: { errors: [["BAD_ID", `${thing_id} is not a t1_ or t3_ id`, "thing_id"]] },
      });
      expect(p.fetched).toEqual([]);
    }
  });

  it("no such thing on Reddit", async () => {
    const p = commentPage({ thing: "t3_abc", permalink: null });
    expect(await redditComment.run(p.fp, { thing_id: "t3_abc", text: "hi" })).toEqual({
      json: { errors: [["NO_THING", "no t3_abc on Reddit", "thing_id"]] },
    });
    expect(p.acts).toEqual([]);
  });

  it("a locked post or a comment with no reply link is refused before typing", async () => {
    const post = commentPage({ thing: "t3_abc", permalink: "/r/x/comments/abc/t/", form: false });
    expect(await redditComment.run(post.fp, { thing_id: "t3_abc", text: "hi" })).toEqual({
      json: {
        errors: [["NO_REPLY", "the post takes no comments (archived or locked)", "thing_id"]],
      },
    });
    expect(post.acts).toEqual([]);
    const reply = commentPage({
      thing: "t1_c1",
      permalink: "/r/x/comments/abc/t/c1/",
      reply: false,
    });
    const out = await redditComment.run(reply.fp, { thing_id: "t1_c1", text: "hi" });
    expect(out.json.errors[0]?.[0]).toBe("NO_REPLY");
    expect(reply.acts).toEqual([]);
  });

  it("a refused save answers the scoped form's errors", async () => {
    const p = commentPage({
      thing: "t3_abc",
      permalink: "/r/x/comments/abc/t/",
      errors: [el({ cls: "error RATELIMIT field-ratelimit", text: "you are doing that too much" })],
    });
    expect(await redditComment.run(p.fp, { thing_id: "t3_abc", text: "hi" })).toEqual({
      json: { errors: [["RATELIMIT", "you are doing that too much", "ratelimit"]] },
    });
  });

  it("nothing new of ours and no error: polls for 30s, then a person", async () => {
    const p = commentPage({
      thing: "t3_abc",
      permalink: "/r/x/comments/abc/t/",
      existing: [comment("t1_old", "WrenAutomation")],
      // Someone else's comment appearing is not ours.
      made: [comment("t1_theirs", "someone")],
    });
    await expect(redditComment.run(p.fp, { thing_id: "t3_abc", text: "hi" })).rejects.toThrow(
      /neither showed up nor said why/,
    );
    expect(p.waits()).toBe(30);
  });

  it("signed out (no header user): no comment counts as ours", async () => {
    const p = commentPage({
      thing: "t3_abc",
      permalink: "/r/x/comments/abc/t/",
      me: "",
      made: [comment("t1_new", "")],
    });
    await expect(redditComment.run(p.fp, { thing_id: "t3_abc", text: "hi" })).rejects.toThrow(
      NeedsHuman,
    );
  });

  it("a captcha on the comment form is passed before the save", async () => {
    const p = commentPage({
      thing: "t3_abc",
      permalink: "/r/x/comments/abc/t/",
      captcha: true,
      made: [comment("t1_new", "WrenAutomation")],
    });
    const out = await redditComment.run(p.fp, { thing_id: "t3_abc", text: "hi" });
    expect(out.json.errors).toEqual([]);
  });
});
