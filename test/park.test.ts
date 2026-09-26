import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defineFlow, flowRunner } from "../src/browser/flow.js";
import { SessionPark } from "../src/browser/park.js";
import { NeedsHuman } from "../src/browser/session.js";

describe("SessionPark", () => {
  const server = createServer((_q, r) =>
    r.writeHead(200, { "content-type": "text/html" }).end("<input id=f>"),
  );
  const ready = new Promise<string>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}/form`),
    ),
  );
  const park = new SessionPark({ idleMs: 60_000, max: 1 });
  const dir = mkdtempSync(join(tmpdir(), "autobrowse-park-"));
  const runner = flowRunner(
    {
      tier: "local",
      channel: "chromium",
      profilesDir: join(dir, "profiles"),
      artifactsDir: join(dir, "artifacts"),
      headless: true,
    },
    { pace: null, park },
  );
  afterAll(async () => {
    await park.closeAll();
    server.close();
  });

  it("a hand-off keeps the browser on its page for the next run", async () => {
    const url = await ready;
    const fill = defineFlow<undefined, void>({
      site: "scratch",
      name: "fill",
      async run(fp) {
        await fp.open(url);
        await fp.page.fill("#f", "half done");
        throw new NeedsHuman("pick one");
      },
    });
    const resume = defineFlow<undefined, string>({
      site: "scratch",
      name: "resume",
      async run(fp) {
        await fp.open(url);
        return fp.page.inputValue("#f");
      },
    });
    await expect(runner.run(fill, undefined)).rejects.toBeInstanceOf(NeedsHuman);
    expect(park.size).toBe(1);
    expect(await runner.run(resume, undefined)).toBe("half done");
    // Kept again for the run after.
    expect(park.size).toBe(1);
  }, 60_000);

  it("keeps at most `max`, closing the oldest", async () => {
    const other = defineFlow<undefined, void>({
      site: "scratch-2",
      name: "noop",
      async run() {},
    });
    await runner.run(other, undefined);
    expect(park.size).toBe(1);
    expect(await park.take("scratch")).toBeNull();
    expect(await park.take("scratch-2")).not.toBeNull();
  }, 60_000);
});
