import { describe, expect, it, vi } from "vitest";
import type { FlowRunner } from "../src/browser/flow.js";
import { linkedinCreatePost } from "../src/browser/flows/linkedin-create-post.js";
import type { Hints } from "../src/browser/locate.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { siteFacade } from "../src/sites/facade.js";
import { linkedin } from "../src/sites/linkedin.js";
import { prefersBrowser } from "../src/sites/types.js";
import { fakePage } from "./auth-fakes.js";
import { fakeFetch } from "./fakes.js";

const PAGE = "urn:li:organization:143656154";
const MEMBER = "urn:li:person:abc123";

const line = (a: { op: { kind: string }; hints: Hints }) =>
  `${a.op.kind} ${a.hints.name ?? a.hints.css}`;

describe("linkedin/create-post", () => {
  it("is the posts route's browser leg, told which author it posts as", () => {
    const route = linkedin.routes.find((r) => r.path === "/rest/posts" && r.method === "POST");
    expect(route?.browser?.flow).toBe("linkedin/create-post");
    expect(route?.irreversible).toBe(true);
    const input = (author: string) =>
      route?.browser?.input?.(
        { author, commentary: "hi", visibility: "PUBLIC" } as never,
        () => undefined,
      );
    expect(input(PAGE)).toEqual({ text: "hi", visibility: "PUBLIC", page: "143656154" });
    expect(input(MEMBER)).toEqual({ text: "hi", visibility: "PUBLIC", page: undefined });
    expect(BROWSER_FLOWS["linkedin/create-post"]).toBe(linkedinCreatePost);
  });

  it("a Page's post goes by the browser even with a token; the member's by the API", async () => {
    const route = linkedin.routes.find((r) => r.path === "/rest/posts" && r.method === "POST");
    expect(prefersBrowser(route as never)).toBe(false);
    const api = fakeFetch(() => ({ status: 201, headers: { "x-restli-id": "urn:li:share:1" } }));
    const seen: string[] = [];
    const runner: FlowRunner = {
      async run(flow, input) {
        seen.push(`${flow.site} ${flow.name} ${JSON.stringify(input)}`);
        return { url: "https://www.linkedin.com/feed/update/urn:li:activity:2/" } as never;
      },
    };
    const env: Record<string, string> = { LINKEDIN_ACCESS_TOKEN__HELLO_WREN_TEST: "tok" };
    const sites = siteFacade([linkedin], {
      http: httpClient({ fetch: api.fetch }),
      env: (n) => env[n],
      sink: memorySink(),
      runner,
      flow: (n) => BROWSER_FLOWS[n] ?? null,
      providerOf: () => null,
      accountFor: async () => "hello@wren.test",
      profileFor: async (site) => `${site}@wren`,
    });
    const post = (author: string) =>
      sites.call("linkedin", "POST", "/rest/posts", { author, commentary: "hi" });

    expect(await post(MEMBER)).toEqual({ id: "urn:li:share:1" });
    expect(api.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["POST /rest/posts"]);
    expect(seen).toEqual([]);

    expect(await post(PAGE)).toEqual({
      url: "https://www.linkedin.com/feed/update/urn:li:activity:2/",
    });
    expect(api.calls).toHaveLength(1);
    expect(seen).toEqual([
      'linkedin@wren create-post {"text":"hi","visibility":"PUBLIC","page":"143656154"}',
    ]);

    await expect(post("urn:li:organization:999")).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(1);
  });

  it("reads the Page's name live, switches to it, types the post and answers with its permalink", async () => {
    let posted = false;
    const { fp, acts } = fakePage({
      text: ["", "", "", "", "Post successful"],
      present: () => true,
      read: (h) => (h.css === "h1" ? " Wren " : "Post to Anyone"),
      url: "https://www.linkedin.com/sharing/compose",
      onAct: (n) => {
        if (n === 5) posted = true;
      },
    });
    fp.html = async () =>
      posted ? '<div data-urn="urn:li:activity:7300000000000000000"></div>' : "";
    const out = await linkedinCreatePost.run(fp, {
      text: "hello",
      page: "143656154",
      visibility: "PUBLIC",
    });
    expect(acts.map(line)).toEqual([
      "click div[role=button][aria-expanded]",
      "click Wren",
      "click /^(done|save)$/i",
      "fill div[role=textbox]",
      "click /^post$/i",
    ]);
    expect(out).toEqual({
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000000/",
    });
  });

  it("refuses an author this account cannot post as, before anything is typed", async () => {
    const { fp, acts } = fakePage({
      text: [""],
      present: (h) => h.role !== "radio",
      read: (h) => (h.css === "h1" ? "Someone Else" : "Post to Anyone"),
    });
    await expect(linkedinCreatePost.run(fp, { text: "hi", page: "999" })).rejects.toThrow(
      /"Someone Else" is not an author this account can post as/,
    );
    expect(acts.map(line)).toEqual(["click div[role=button][aria-expanded]"]);
  });

  it("hands over when the composer never renders, before any act", async () => {
    const { fp, acts } = fakePage({ text: [""], present: () => false });
    await expect(linkedinCreatePost.run(fp, { text: "hi" })).rejects.toThrow(
      /composer did not open/,
    );
    expect(acts).toEqual([]);
  });
});

describe("linkedin upload", () => {
  it("starts the upload, PUTs the fetched bytes with the token, answers the URN", async () => {
    const api = fakeFetch((req) =>
      req.method === "POST"
        ? {
            body: {
              value: {
                uploadUrl: "https://www.linkedin.com/dms-uploads/d1",
                document: "urn:li:document:D1",
              },
            },
          }
        : { status: 201 },
    );
    const file = vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70])));
    vi.stubGlobal("fetch", file);
    try {
      const env: Record<string, string> = { LINKEDIN_ACCESS_TOKEN__HELLO_WREN_TEST: "tok" };
      const sites = siteFacade([linkedin], {
        http: httpClient({ fetch: api.fetch }),
        env: (n) => env[n],
        sink: memorySink(),
        providerOf: () => null,
        accountFor: async () => "hello@wren.test",
      });
      const out = await sites.call("linkedin", "POST", "/upload", {
        kind: "document",
        owner: PAGE,
        file: "https://media.test/deck.pdf",
      });
      expect(out).toEqual({ urn: "urn:li:document:D1" });
      expect(file).toHaveBeenCalledWith("https://media.test/deck.pdf");
      expect(api.calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
        "POST /rest/documents?action=initializeUpload",
        "PUT /dms-uploads/d1",
      ]);
      expect(api.calls[0]?.body).toContain(PAGE);
      expect(api.calls[1]?.headers.get("authorization")).toBe("Bearer tok");
      expect(api.calls[1]?.body).toBe("<bytes>");
      await expect(
        sites.call("linkedin", "POST", "/upload", {
          kind: "image",
          owner: PAGE,
          file: "/etc/hosts",
        }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
