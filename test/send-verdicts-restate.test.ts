/**
 * Send verdicts under a real Restate (designs/2026-10-16-send-verdicts.md, "Done when"): a keyed
 * write killed after its submit step, then rerun with its key, answers the verdict without a
 * second write. One test per leg, API and browser. The first call carries the Restate idempotency
 * key equal to the send key, as wren sets it. Old code: the killed call left no record, so a rerun
 * wrote again or threw "already went through". Needs Docker.
 */
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileSendJournal, type SendJournal, sitesService } from "../src/sites/index.js";
import { platform, resetPlatform, scratchFacade } from "./send-rig.js";

const NAME = "sites_verdicts_restate";
let dir: string;
let env: RestateTestEnvironment;
let journal: SendJournal;

/** A Restate that cannot be left behind (same as profile-wait-restate.test.ts). */
const container = () => {
  const c = new RestateContainer();
  (c as unknown as { hostConfig: { AutoRemove?: boolean } }).hostConfig.AutoRemove = true;
  return c
    .withAutoRemove(false)
    .withEntrypoint(["timeout", "-s", "KILL", "30m", "/usr/local/bin/restate-server"])
    .withCommand([])
    .alwaysReplay();
};

type Handlers = {
  call: (req: unknown) => Promise<unknown>;
  verdict: (req: { sendKey: string }) => Promise<unknown>;
};
const ingress = () => clients.connect({ url: env.baseUrl() });
const svc = () => ingress().serviceClient<Handlers>({ name: NAME });
const sender = () => ingress().serviceSendClient<Handlers>({ name: NAME });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "send-verdicts-"));
  journal = fileSendJournal(join(dir, "sends"));
  const start = () =>
    RestateTestEnvironment.start({
      services: [
        sitesService(scratchFacade(join(dir, "started")), NAME, undefined, null, {
          journal,
          // Short, so a verify read does not wait half a minute.
          verifyPausesMs: [200, 400, 600],
        }),
      ],
      container,
      serviceEndpointAccess: "docker-host",
    });
  env = await start().catch(start);
}, 180_000);

afterAll(async () => {
  await env?.stop();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(resetPlatform);

const until = async (what: string, ok: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

/**
 * Run a keyed write with the idempotency key set to the send key. Hold it after its submit step,
 * kill the invocation through the admin API, then let the leg fail as a crashed process would.
 */
async function writeKilledAfterSubmit(req: Record<string, unknown>, key: string) {
  platform.mode = "hold";
  let release = () => {};
  platform.release = new Promise<void>((ok) => {
    release = ok;
  });
  const sent = await sender().call(
    { ...req, sendKey: key },
    clients.rpc.sendOpts({ idempotencyKey: key }),
  );
  await until(
    "the write reached the platform and the journal says submitted",
    () => platform.writes.length === 1 && journal.get(key)?.submitted === true,
  );
  const res = await fetch(`${env.adminAPIBaseUrl()}/invocations/${sent.invocationId}/kill`, {
    method: "PATCH",
  });
  expect(res.ok).toBe(true);
  // The leg dies as a crash would: its work is done on the platform, nothing comes back.
  release();
  await until("the leg ended", () => !journal.live(key));
  return sent;
}

const comment = (text: string) => ({
  site: "scratch",
  method: "POST",
  path: "/comments",
  input: { thread: "t1", text },
});
const video = (title: string) => ({
  site: "scratch",
  method: "POST",
  path: "/videos",
  input: { title },
});

describe("a keyed desk write killed after its submit step", () => {
  it("browser leg: a rerun with its key answers `sent` verified, and the page was written once", async () => {
    const key = "restate-browser-1";
    const killed = await writeKilledAfterSubmit(comment("killed comment"), key);
    // Restate gives a repeat of the idempotency key the kill, not the work. This is why `verdict` exists.
    await expect(ingress().result(killed)).rejects.toThrow();
    expect(journal.get(key)).toMatchObject({ submitted: true });
    expect(journal.get(key)?.verdict).toBeUndefined();

    const again = await svc().call({ ...comment("killed comment"), sendKey: key });
    expect(again).toMatchObject({ verdict: "sent", how: "verified", id: "c1" });
    expect(platform.writes).toEqual(["comment killed comment"]);

    // `sites/verdict` answers the same, with no leg and no read.
    const reads = platform.reads;
    expect(await svc().verdict({ sendKey: key })).toEqual(again);
    expect(platform.reads).toBe(reads);
    expect(platform.writes).toHaveLength(1);
  }, 60_000);

  it("API leg: `verdict` answers the lagging write `unknown`, then `sent` once it shows; no second publish", async () => {
    const key = "restate-api-1";
    platform.lagging = true;
    await writeKilledAfterSubmit(video("killed video"), key);

    // The list does not show the video yet: three reads, then unknown. Never `not_sent`.
    const first = await svc().verdict({ sendKey: key });
    expect(first).toMatchObject({ verdict: "unknown" });
    expect(platform.writes).toEqual(["video killed video"]);

    // It shows now. A rerun with the key reads again and answers; it does not publish again.
    for (const v of platform.videos) v.visible = true;
    const again = await svc().call({ ...video("killed video"), sendKey: key });
    expect(again).toMatchObject({ verdict: "sent", how: "verified", id: "v:killed video" });
    expect(platform.writes).toEqual(["video killed video"]);
    expect(await svc().verdict({ sendKey: key })).toEqual(again);
  }, 60_000);

  it("API leg: the video shows at once, so a rerun with its key is `sent` verified", async () => {
    const key = "restate-api-2";
    await writeKilledAfterSubmit(video("shown video"), key);
    const again = await svc().call({ ...video("shown video"), sendKey: key });
    expect(again).toMatchObject({ verdict: "sent", how: "verified", id: "v:shown video" });
    expect(platform.writes).toEqual(["video shown video"]);
  }, 60_000);

  it("a call that ends by itself carries its verdict through the idempotency key", async () => {
    const key = "restate-browser-2";
    platform.mode = "close"; // the act went through, then the page closed (the 10-15 Reddit case)
    const first = await svc().call(
      { ...comment("closed page"), sendKey: key },
      clients.rpc.opts({ idempotencyKey: key }),
    );
    expect(first).toMatchObject({ verdict: "sent", how: "verified" });
    // The same key again is the same invocation: one verdict, one write.
    const again = await svc().call(
      { ...comment("closed page"), sendKey: key },
      clients.rpc.opts({ idempotencyKey: key }),
    );
    expect(again).toEqual(first);
    expect(platform.writes).toEqual(["comment closed page"]);
  }, 60_000);

  it("no record under a key answers `not_sent` before_submit", async () => {
    expect(await svc().verdict({ sendKey: "restate-none" })).toMatchObject({
      verdict: "not_sent",
      how: "before_submit",
      reason: "no send under this key",
    });
  });
});

describe("the verdict handler's shape", () => {
  it("rejects an empty or over-long key", async () => {
    await expect(svc().verdict({ sendKey: "" })).rejects.toBeTruthy();
    await expect(svc().verdict({ sendKey: "k".repeat(201) })).rejects.toBeTruthy();
  });
});
