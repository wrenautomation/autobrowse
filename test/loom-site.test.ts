import { afterEach, describe, expect, it, vi } from "vitest";
import { loomDelete, loomRename, loomUpload } from "../src/browser/flows/loom.js";
import { HttpError, httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { memoryCaps } from "../src/sites/caps.js";
import { LOOM_ORIGIN, loom, SITES, SiteError, siteFacade } from "../src/sites/index.js";
import { fakeBrowser, fakeFetch } from "./fakes.js";

const ID = "0123456789abcdef0123456789abcdef";
const routeOf = (method: string, path: string) => {
  const r = loom.routes.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`no route ${method} ${path}`);
  return r;
};
const ok = (method: string, path: string, input: unknown) =>
  routeOf(method, path).request.safeParse(input).success;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loom site", () => {
  it("is served, open, GET on the API and writes on the loom flows", () => {
    expect(SITES).toContain(loom);
    expect(loom.origin).toBe(LOOM_ORIGIN);
    expect(loom.auth).toEqual({ open: true });
    expect(loom.setup).toEqual([]);
    const legs = loom.routes.map((r) => [
      `${r.method} ${r.path}`,
      r.api ? "api" : null,
      r.browser && "flow" in r.browser ? r.browser.flow : null,
    ]);
    expect(legs).toEqual([
      ["GET /videos/{id}", "api", null],
      ["POST /videos", null, "loom/upload"],
      ["PATCH /videos/{id}", null, "loom/rename"],
      ["DELETE /videos/{id}", null, "loom/delete"],
    ]);
    expect(routeOf("POST", "/videos").browser).toMatchObject({ uploads: "file" });
    expect(BROWSER_FLOWS["loom/upload"]).toBe(loomUpload);
    expect(BROWSER_FLOWS["loom/rename"]).toBe(loomRename);
    expect(BROWSER_FLOWS["loom/delete"]).toBe(loomDelete);
  });

  it("only DELETE is irreversible; writes are metered, reads are not", () => {
    for (const r of loom.routes) expect(r.irreversible ?? false).toBe(r.method === "DELETE");
    expect(routeOf("GET", "/videos/{id}").meter).toBeUndefined();
    expect(routeOf("POST", "/videos").meter?.({} as never)).toEqual({ uploads: 1 });
    expect(routeOf("PATCH", "/videos/{id}").meter?.({} as never)).toEqual({ edits: 1 });
    expect(routeOf("DELETE", "/videos/{id}").meter?.({} as never)).toEqual({ edits: 1 });
  });

  it("is capped and paced", () => {
    expect(loom.caps).toEqual({ uploads: 10, edits: 50 });
    expect(loom.pace).toEqual({ gapMs: 5_000, jitterMs: 10_000 });
  });
});

describe("loom request shapes", () => {
  it("an id is 32 lowercase hex characters", () => {
    for (const m of ["GET", "DELETE"] as const) {
      expect(ok(m, "/videos/{id}", { id: ID })).toBe(true);
      for (const id of [
        "",
        ID.slice(1),
        `${ID}0`,
        ID.toUpperCase(),
        `${ID.slice(1)}g`,
        `${ID.slice(2)}/x`,
        "../home",
      ])
        expect(ok(m, "/videos/{id}", { id }), id).toBe(false);
    }
  });

  it("a title is 1 to 200; rename needs one, upload may skip it", () => {
    const P = ["PATCH", "/videos/{id}"] as const;
    expect(ok(...P, { id: ID, title: "x" })).toBe(true);
    expect(ok(...P, { id: ID, title: "x".repeat(200) })).toBe(true);
    expect(ok(...P, { id: ID, title: "x".repeat(201) })).toBe(false);
    expect(ok(...P, { id: ID, title: "" })).toBe(false);
    expect(ok(...P, { id: ID })).toBe(false);
    expect(ok(...P, { id: "abc", title: "x" })).toBe(false);
    const U = ["POST", "/videos"] as const;
    expect(ok(...U, { file: "/tmp/v.mp4" })).toBe(true);
    expect(ok(...U, { file: "/tmp/v.mp4", title: "x".repeat(200) })).toBe(true);
    expect(ok(...U, { file: "/tmp/v.mp4", title: "x".repeat(201) })).toBe(false);
    expect(ok(...U, { file: "/tmp/v.mp4", title: "" })).toBe(false);
    expect(ok(...U, { file: "" })).toBe(false);
    expect(ok(...U, {})).toBe(false);
  });
});

describe("loom through the facade", () => {
  const noon = Date.UTC(2026, 8, 29, 12);
  function facade(answer: Parameters<typeof fakeFetch>[0] = () => ({ status: 200, body: {} })) {
    const inputs: Array<[string, unknown]> = [];
    const browser = fakeBrowser([]);
    browser.on(loomUpload, async (i) => {
      inputs.push(["upload", i]);
      return { id: ID, url: `${LOOM_ORIGIN}/share/${ID}`, title: i.title ?? null };
    });
    browser.on(loomRename, async (i) => {
      inputs.push(["rename", i]);
      return { id: i.id, url: `${LOOM_ORIGIN}/share/${i.id}`, title: i.title };
    });
    browser.on(loomDelete, async (i) => {
      inputs.push(["delete", i]);
      return { id: i.id, deleted: true as const };
    });
    const http = fakeFetch(answer);
    const caps = memoryCaps(() => noon);
    const sites = siteFacade([{ ...loom, pace: { gapMs: 0 } }], {
      http: httpClient({ fetch: http.fetch, attempts: 1 }),
      env: () => undefined,
      sink: memorySink(),
      runner: browser,
      flow: (n) => BROWSER_FLOWS[n] ?? null,
      caps,
      sleep: async () => {},
    });
    return { sites, inputs, caps, calls: http.calls };
  }

  it("status: GET on the API, writes in the browser, DELETE flagged", async () => {
    const { sites } = facade();
    const row = await sites.status("loom");
    expect(row.authed).toBe(true);
    expect(row.routes.map((r) => r.via)).toEqual(["api", "browser", "browser", "browser"]);
    expect(row.routes.filter((r) => r.irreversible).map((r) => r.path)).toEqual(["/videos/{id}"]);
  });

  it("GET asks oEmbed for the share URL and merges id and url into its answer", async () => {
    const { sites, calls, inputs } = facade(() => ({
      status: 200,
      body: { title: "Demo", duration: 12.5, thumbnail_url: "t" },
    }));
    const out = await sites.call("loom", "GET", `/videos/${ID}`, {});
    expect(calls).toHaveLength(1);
    const u = calls[0]?.url;
    expect(calls[0]?.method).toBe("GET");
    expect(`${u?.origin}${u?.pathname}`).toBe(`${LOOM_ORIGIN}/v1/oembed`);
    expect(u?.searchParams.get("url")).toBe(`${LOOM_ORIGIN}/share/${ID}`);
    expect(out).toEqual({
      id: ID,
      url: `${LOOM_ORIGIN}/share/${ID}`,
      title: "Demo",
      duration: 12.5,
      thumbnail_url: "t",
    });
    expect(inputs).toEqual([]);
  });

  it("a non-ok oEmbed is an HttpError with its status and no query string", async () => {
    const { sites } = facade(() => ({ status: 404 }));
    const err = await sites.call("loom", "GET", `/videos/${ID}`, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 404 });
    const msg = (err as Error).message;
    expect(msg).toContain(`${LOOM_ORIGIN}/v1/oembed`);
    expect(msg).toContain("404");
    expect(msg).not.toContain("?");
    expect(msg).not.toContain(ID);
  });

  it("a bad id is a 400 that never fetches", async () => {
    const { sites, calls } = facade();
    const err = await sites.call("loom", "GET", "/videos/abc", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteError);
    expect(err).toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });

  it("POST runs the upload flow and spends one upload; the eleventh is a 429", async () => {
    const { sites, inputs, caps } = facade();
    const out = await sites.call("loom", "POST", "/videos", { file: "/tmp/v.mp4", title: "Hi" });
    expect(out).toEqual({ id: ID, url: `${LOOM_ORIGIN}/share/${ID}`, title: "Hi" });
    expect(inputs).toEqual([["upload", { file: "/tmp/v.mp4", title: "Hi" }]]);
    expect(caps.today()["loom|loom|uploads"]).toBe(1);
    for (let i = 1; i < 10; i++)
      await sites.call("loom", "POST", "/videos", { file: "/tmp/v.mp4" });
    await expect(
      sites.call("loom", "POST", "/videos", { file: "/tmp/v.mp4" }),
    ).rejects.toMatchObject({ status: 429 });
    expect(inputs).toHaveLength(10);
    // Edits have their own bucket.
    await sites.call("loom", "PATCH", `/videos/${ID}`, { title: "T" });
    expect(caps.today()["loom|loom|edits"]).toBe(1);
  });

  it("POST with a media URL hands the flow a local file", async () => {
    vi.stubGlobal("fetch", async () => new Response("bytes", { status: 200 }));
    const { sites, inputs } = facade();
    await sites.call("loom", "POST", "/videos", {
      file: "https://bucket.example/v.mp4?X-Amz-Signature=abc",
    });
    const file = (inputs[0]?.[1] as { file?: string } | undefined)?.file ?? "";
    expect(file).not.toMatch(/^https?:/);
    expect(file).toMatch(/media\.mp4$/);
  });

  it("PATCH and DELETE reach their flows with the path's id", async () => {
    const { sites, inputs } = facade();
    await sites.call("loom", "PATCH", `/videos/${ID}`, { title: "T" });
    expect(await sites.call("loom", "DELETE", `/videos/${ID}`, {})).toEqual({
      id: ID,
      deleted: true,
    });
    expect(inputs).toEqual([
      ["rename", { id: ID, title: "T" }],
      ["delete", { id: ID }],
    ]);
  });
});
