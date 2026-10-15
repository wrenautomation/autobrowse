import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileDoneActs, withCall } from "../src/browser/attempt.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { MAY_HAVE_GONE, siteFacade } from "../src/sites/facade.js";
import { linkedin } from "../src/sites/linkedin.js";
import { fakeFetch } from "./fakes.js";

const MEMBER = "urn:li:person:abc123";

describe("a rerun of a started publish", () => {
  it("posts once per durable call, refuses the rerun, and leaves local runs alone", async () => {
    const api = fakeFetch(() => ({ status: 201, headers: { "x-restli-id": "urn:li:share:1" } }));
    const sites = siteFacade([linkedin], {
      http: httpClient({ fetch: api.fetch }),
      env: (n) => ({ LINKEDIN_ACCESS_TOKEN__HELLO_WREN_TEST: "tok" })[n],
      sink: memorySink(),
      runner: { run: async () => ({}) as never },
      flow: (n) => BROWSER_FLOWS[n] ?? null,
      providerOf: () => null,
      accountFor: async () => "hello@wren.test",
      profileFor: async (site) => `${site}@wren`,
      started: fileDoneActs(mkdtempSync(join(tmpdir(), "started-"))),
    });
    const post = () =>
      sites.call("linkedin", "POST", "/rest/posts", { author: MEMBER, commentary: "hi" });

    expect(await withCall("inv-1 step", post)).toEqual({ id: "urn:li:share:1" });
    await expect(withCall("inv-1 step", post)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(MAY_HAVE_GONE),
    });
    expect(await withCall("inv-2 step", post)).toEqual({ id: "urn:li:share:1" });
    // Outside Restate nothing reruns a call: the guard stays out of the way.
    await post();
    await post();
    expect(api.calls).toHaveLength(4);
  });
});
