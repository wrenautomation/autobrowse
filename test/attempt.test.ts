import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileDoneActs, withCall } from "../src/browser/attempt.js";
import { defineFlow, flowRunner } from "../src/browser/flow.js";
import { NeedsHuman } from "../src/browser/session.js";

describe("a retried call never repeats an irreversible act", () => {
  let posts = 0;
  const server = createServer((q, r) => {
    if (q.url === "/post") posts += 1;
    r.writeHead(200, { "content-type": "text/html" }).end(
      "<title>t</title><button onclick=\"fetch('/post')\">Post</button>",
    );
  });
  const ready = new Promise<string>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`),
    ),
  );
  afterAll(() => server.close());

  it("the retry stops before the post; a new call posts", async () => {
    const url = await ready;
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-done-"));
    const runner = flowRunner(
      {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
      { pace: null, done: fileDoneActs(join(dir, "done")) },
    );
    let breakAfter = true;
    const post = defineFlow<undefined, void>({
      site: "scratch",
      name: "post",
      async run(fp) {
        await fp.open(url);
        await fp.act(
          { kind: "click" },
          { role: "button", name: "Post" },
          {
            goal: "post it",
            irreversible: true,
          },
        );
        await fp.wait(300);
        if (breakAfter) throw new Error("net::ERR_INTERNET_DISCONNECTED after the post");
      },
    });
    await expect(withCall("inv-1 step", () => runner.run(post, undefined))).rejects.toThrow();
    expect(posts).toBe(1);
    breakAfter = false;
    await expect(withCall("inv-1 step", () => runner.run(post, undefined))).rejects.toBeInstanceOf(
      NeedsHuman,
    );
    expect(posts).toBe(1);
    await withCall("inv-2 step", () => runner.run(post, undefined));
    expect(posts).toBe(2);
  }, 60_000);
});
