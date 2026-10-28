/**
 * Send verdicts (designs/2026-10-16-send-verdicts.md): a keyed write answers a typed verdict, never
 * words in an error. Each test names the old behavior it replaces. Synthetic site, no real data.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { markSubmitted } from "../src/browser/attempt.js";
import {
  fileSendJournal,
  memorySendJournal,
  type SendJournal,
  type SiteFacade,
  sitesService,
  VERIFY_PAUSES_MS,
} from "../src/sites/index.js";
import type { SendVerdict } from "../src/sites/verdict.js";
import { platform, resetPlatform, scratchFacade } from "./send-rig.js";

let dir: string;
let journal: SendJournal;
const diskJournal = () => fileSendJournal(join(dir, "sends"));

/** The pauses before the three verify reads in a test: small, and different. */
const PAUSES = [1, 2, 3];

function build(opts: { wait?: { boundMs: number; pausesMs: number[] } } = {}) {
  const facade = scratchFacade(join(dir, "started"));
  const svc = sitesService(facade, "sites_verdicts", undefined, null, {
    journal,
    verifyPausesMs: PAUSES,
    ...(opts.wait ? { wait: opts.wait } : {}),
  }) as unknown as { service: Record<string, (ctx: never, req: unknown) => Promise<unknown>> };
  const sleeps: number[] = [];
  let n = 0;
  const ctx = () =>
    ({
      request: () => ({ id: `inv_${++n}`, headers: new Map<string, string>() }),
      run: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      sleep: async (ms: number) => void sleeps.push(ms),
    }) as never;
  const call = (req: Record<string, unknown>) => svc.service.call?.(ctx(), req);
  const verdict = (sendKey: string) => svc.service.verdict?.(ctx(), { sendKey });
  return { call, verdict, sleeps, facade };
}

const COMMENT = { site: "scratch", method: "POST", path: "/comments" } as const;
const say = (text: string, sendKey?: string) => ({
  ...COMMENT,
  input: { thread: "t1", text },
  ...(sendKey ? { sendKey } : {}),
});
const VIDEO = { site: "scratch", method: "POST", path: "/videos" } as const;
/** The platform finishes processing: every video shows in the list. */
const showVideos = () => {
  for (const v of platform.videos) v.visible = true;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autobrowse-verdicts-"));
  journal = memorySendJournal();
  resetPlatform();
});

describe("a keyed write answers a verdict", () => {
  it("the platform's answer is `sent`, with its id, link and the official output", async () => {
    const { call } = build();
    expect(await call(say("first words", "k-ok"))).toMatchObject({
      verdict: "sent",
      how: "answer",
      id: "c1",
      url: "https://scratch.test/c/c1",
      output: { id: "c1", url: "https://scratch.test/c/c1" },
    });
    // The leg ran under the send key, and the journal had `submitted` on disk before the act.
    expect(platform.keys).toEqual(["send k-ok"]);
  });

  it("10-26 Mac off all day: a write first run past its `until` is `not_sent`, and nothing is written (old code: it landed a day late)", async () => {
    const { call } = build();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(await call({ ...say("late words", "k-late"), until: past })).toMatchObject({
      verdict: "not_sent",
      how: "before_submit",
    });
    expect(platform.writes).toEqual([]);
    // Inside its day it goes as before.
    const later = new Date(Date.now() + 3_600_000).toISOString();
    expect(await call({ ...say("on time", "k-on-time"), until: later })).toMatchObject({
      verdict: "sent",
    });
  });

  it("a started write past its `until` is settled by its record, never called late", async () => {
    const { call } = build();
    const first = await call(say("started words", "k-started"));
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(await call({ ...say("started words", "k-started"), until: past })).toEqual(first);
  });

  it("an unkeyed write past its `until` ends with a terminal 410", async () => {
    const { call } = build();
    const past = new Date(Date.now() - 60_000).toISOString();
    await expect(
      call({ ...COMMENT, input: { thread: "t1", text: "x" }, until: past }),
    ).rejects.toMatchObject({ code: 410 });
  });

  it("writes `submitted` to disk before the act (old code kept no record)", async () => {
    journal = diskJournal();
    const onDisk: (boolean | undefined)[] = [];
    // Read the file as the act goes out, with a fresh journal: this is what a crash would find.
    platform.onAct = (key) => void onDisk.push(diskJournal().get(key)?.submitted);
    const { call } = build();
    await call(say("disk words", "k-disk"));
    expect(onDisk).toEqual([true]);
  });

  it("10-15 Reddit: the act went through, then the page closed; the verify read says sent (old code: terminal 'may have gone through', and a rerun threw 'already went through')", async () => {
    platform.mode = "close";
    const { call, sleeps } = build();
    const first = (await call(say("a comment that went out", "k-reddit"))) as SendVerdict;
    expect(first).toMatchObject({ verdict: "sent", how: "verified", id: "c1" });
    expect(sleeps).toEqual([PAUSES[0]]);
    // A rerun with the same key answers the same verdict; the write ran once.
    const again = await call(say("a comment that went out", "k-reddit"));
    expect(again).toEqual(first);
    expect(platform.writes).toEqual(["comment a comment that went out"]);
  });

  it("10-16 TikTok: the request went out and the answer was lost; a lagging list is `unknown`, never `not_sent` (old code: terminal 'may have gone through', wren marked a live video failed)", async () => {
    platform.mode = "lost";
    platform.lagging = true;
    const { call, sleeps } = build();
    const first = (await call({ ...VIDEO, input: { title: "my demo" }, sendKey: "k-tt" })) as {
      verdict: string;
      reason: string;
    };
    expect(first.verdict).toBe("unknown");
    expect(first.reason).toMatch(/after processing/);
    // Three reads, the pauses between, no more.
    expect(sleeps).toEqual(PAUSES);
    expect(platform.reads).toBe(3);
    // The video shows now. The same key reads again; it never publishes again.
    showVideos();
    const again = await call({ ...VIDEO, input: { title: "my demo" }, sendKey: "k-tt" });
    expect(again).toMatchObject({ verdict: "sent", how: "verified", id: "v:my demo" });
    expect(platform.writes).toEqual(["video my demo"]);
  });

  it("10-16 TikTok: the list shows the video at once, so `sent` verified", async () => {
    platform.mode = "lost";
    const { call } = build();
    expect(
      await call({ ...VIDEO, input: { title: "shown video" }, sendKey: "k-tt2" }),
    ).toMatchObject({
      verdict: "sent",
      how: "verified",
      id: "v:shown video",
    });
  });

  it("a full read that finds nothing is `not_sent` verified_absent", async () => {
    platform.mode = "died";
    const { call } = build();
    expect(await call(say("never posted", "k-absent"))).toMatchObject({
      verdict: "not_sent",
      how: "verified_absent",
    });
  });

  it("a final verdict repeats without touching the leg (old code ran the write again)", async () => {
    const { call } = build();
    const first = await call(say("only once", "k-final"));
    platform.mode = "close";
    expect(await call(say("only once", "k-final"))).toEqual(first);
    expect(platform.writes).toEqual(["comment only once"]);
    expect(platform.keys).toHaveLength(1);
  });

  it("an `unknown` repeat runs only the verify read", async () => {
    platform.mode = "lost";
    platform.lagging = true;
    const { call } = build();
    await call({ ...VIDEO, input: { title: "slow video" }, sendKey: "k-unk" });
    expect(journal.get("k-unk")?.verdict?.verdict).toBe("unknown");
    platform.reads = 0;
    showVideos();
    await call({ ...VIDEO, input: { title: "slow video" }, sendKey: "k-unk" });
    expect(platform.reads).toBe(1);
    expect(platform.writes).toHaveLength(1);
  });

  it("a route with `verify: { none }` is `unknown` with its reason at once, no reads (old code: words only)", async () => {
    const { call, sleeps } = build();
    expect(
      await call({
        site: "scratch",
        method: "POST",
        path: "/pins",
        input: { note: "n" },
        sendKey: "k-none",
      }),
    ).toMatchObject({ verdict: "unknown", reason: "no list shows a pinned note" });
    expect(sleeps).toEqual([]);
    expect(platform.reads).toBe(0);
    expect(platform.writes).toEqual(["pin n"]);
  });

  it("a route that declares nothing is `unknown`", async () => {
    // A stand-in facade with no spec: an unclear end can only be `unknown`.
    const { facade } = build();
    const bare: SiteFacade = { ...facade };
    delete bare.sendSpec;
    bare.call = async () => {
      markSubmitted();
      throw new Error("socket hang up");
    };
    const svc = sitesService(bare, "sites_bare", undefined, null, {
      journal,
      verifyPausesMs: PAUSES,
    }) as unknown as { service: Record<string, (ctx: never, req: unknown) => Promise<unknown>> };
    const ctx = {
      request: () => ({ id: "inv_x", headers: new Map<string, string>() }),
      run: async <T>(_n: string, fn: () => Promise<T>) => fn(),
      sleep: async () => {},
    } as never;
    expect(await svc.service.call?.(ctx, { ...say("x", "k-bare") })).toMatchObject({
      verdict: "unknown",
      reason: expect.stringMatching(/no verify read/),
    });
  });
});

describe("before the submit step", () => {
  it("a process that died after `start` and before the act is `not_sent` before_submit after a restart", async () => {
    const first = diskJournal();
    first.start({
      key: "k-died",
      site: "scratch",
      method: "POST",
      path: "/comments",
      account: null,
      input: { thread: "t1", text: "never sent" },
    });
    journal = diskJournal(); // the process restarted: a new journal on the same dir
    const { call } = build();
    expect(await call(say("never sent", "k-died"))).toMatchObject({
      verdict: "not_sent",
      how: "before_submit",
    });
    expect(platform.writes).toEqual([]);
    expect(platform.keys).toEqual([]);
  });

  it("a SiteError under 500 before the submit step is still thrown (400, 404, 501)", async () => {
    const { call } = build();
    // 400: the request fails the route's schema.
    await expect(
      call({ ...COMMENT, input: { thread: "t1" }, sendKey: "k-400" }),
    ).rejects.toMatchObject({
      name: "TerminalError",
      code: 400,
    });
    // 404: no such route.
    await expect(
      call({ site: "scratch", method: "POST", path: "/nope", input: {}, sendKey: "k-404" }),
    ).rejects.toMatchObject({ name: "TerminalError", code: 404 });
    // 501: the route's flow is not recorded.
    await expect(
      call({
        site: "scratch",
        method: "POST",
        path: "/dms",
        input: { to: "a", text: "b" },
        sendKey: "k-501",
      }),
    ).rejects.toMatchObject({
      name: "TerminalError",
      code: 501,
      message: expect.stringMatching(/^not sent: .*not recorded yet/),
    });
    // Nothing was attempted, so no key is left behind.
    expect(journal.get("k-400")).toBeNull();
    expect(journal.get("k-404")).toBeNull();
    expect(journal.get("k-501")).toBeNull();
  });

  it("a profile wait that gives up is `not_sent` before_submit (old code: terminal 503 'not sent: profile ... busy')", async () => {
    platform.mode = "busy";
    const { call } = build({ wait: { boundMs: 0, pausesMs: [1] } });
    expect(await call(say("waiting", "k-busy"))).toMatchObject({
      verdict: "not_sent",
      how: "before_submit",
      reason: expect.stringMatching(/busy/),
    });
    expect(journal.get("k-busy")).toBeNull();
  });

  it("a profile busy at first and free later runs the leg once under the same key", async () => {
    platform.mode = "busy";
    const { facade } = build();
    let tries = 0;
    const flaky: SiteFacade = {
      ...facade,
      call: async (...args) => {
        if (tries++ === 0) platform.mode = "busy";
        else platform.mode = "ok";
        return facade.call(...args);
      },
    };
    const svc = sitesService(flaky, "sites_flaky", undefined, null, {
      journal,
      verifyPausesMs: PAUSES,
      wait: { boundMs: 60_000, pausesMs: [1] },
    }) as unknown as { service: Record<string, (ctx: never, req: unknown) => Promise<unknown>> };
    const ctx = {
      request: () => ({ id: "inv_w", headers: new Map<string, string>() }),
      run: async <T>(_n: string, fn: () => Promise<T>) => fn(),
      sleep: async () => {},
    } as never;
    expect(await svc.service.call?.(ctx, say("after the wait", "k-wait"))).toMatchObject({
      verdict: "sent",
      how: "answer",
    });
    expect(platform.writes).toEqual(["comment after the wait"]);
  });
});

describe("an answer with no submit step", () => {
  it("10-17 LinkedIn: the flow found no comment and answered `{ found: false }`: `not_sent` with its reason (old code: `sent` how answer)", async () => {
    platform.mode = "missing";
    const { call } = build();
    expect(await call(say("a reply", "k-missing"))).toEqual({
      verdict: "not_sent",
      reason: "no thread t1",
      how: "before_submit",
    });
    expect(platform.writes).toEqual([]);
    expect(journal.get("k-missing")?.verdict?.verdict).toBe("not_sent");
  });

  it("10-27 TikTok: comments are off, the flow answers `{ found: false, status: 403 }`: `not_sent` refused, so wren drops it (old code: a person's job, re-slotted every pass)", async () => {
    platform.mode = "closed";
    const { call } = build();
    expect(await call(say("a reply", "k-closed"))).toEqual({
      verdict: "not_sent",
      reason: "comments are off on t1",
      how: "refused",
      status: 403,
    });
    expect(platform.writes).toEqual([]);
  });

  it("a flow that says it is already there (`already`) is `sent` how answer", async () => {
    platform.mode = "already";
    const { call } = build();
    expect(await call(say("a reply", "k-already"))).toMatchObject({
      verdict: "sent",
      how: "answer",
      id: "c0",
    });
  });
});

describe("after the submit step", () => {
  it("a submit that was journaled and never settled runs only the verify read after a restart", async () => {
    const first = diskJournal();
    first.start({
      key: "k-crash",
      site: "scratch",
      method: "POST",
      path: "/comments",
      account: null,
      input: { thread: "t1", text: "went out before the crash" },
    });
    first.submitted("k-crash");
    platform.comments.unshift({
      text: "went out before the crash",
      at: new Date().toISOString(),
      id: "c9",
    });
    journal = diskJournal();
    const { call, sleeps } = build();
    expect(await call(say("went out before the crash", "k-crash"))).toMatchObject({
      verdict: "sent",
      how: "verified",
      id: "c9",
    });
    // Read at once: the end was long ago.
    expect(sleeps).toEqual([]);
    expect(platform.writes).toEqual([]);
    expect(platform.keys).toEqual([]);
  });

  it("a platform 4xx after the submit step is `not_sent` refused, with its status (old code: terminal 'may have gone through')", async () => {
    platform.mode = "refuse";
    const { call } = build();
    expect(
      await call({ ...VIDEO, input: { title: "refused video" }, sendKey: "k-403" }),
    ).toMatchObject({
      verdict: "not_sent",
      how: "refused",
      status: 403,
    });
    expect(platform.reads).toBe(0);
  });

  it("the site's own 429 after the submit step is `not_sent` refused, with its words", async () => {
    platform.mode = "limit";
    const { call } = build();
    expect(
      await call({ ...VIDEO, input: { title: "limited video" }, sendKey: "k-429" }),
    ).toMatchObject({
      verdict: "not_sent",
      how: "refused",
      status: 429,
      reason: expect.stringMatching(/weekly limit; retry after 86400s/),
    });
    expect(platform.reads).toBe(0);
  });
});

describe("no key", () => {
  it("an unkeyed write answers today's words (the CLI, older callers)", async () => {
    platform.mode = "close";
    const { call } = build();
    await expect(call(say("no key here"))).rejects.toMatchObject({
      name: "TerminalError",
      message: "page closed after Post; may have gone through",
    });
    platform.mode = "died";
    await expect(call(say("no key either"))).rejects.toMatchObject({
      name: "TerminalError",
      message: "page closed at the click; may have gone through",
    });
  });

  it("an unkeyed write that succeeds answers the official output, not a verdict", async () => {
    const { call } = build();
    expect(await call(say("plain"))).toEqual({ id: "c1", url: "https://scratch.test/c/c1" });
  });

  it("a keyed read ignores the key", async () => {
    const { call } = build();
    expect(
      await call({
        site: "scratch",
        method: "GET",
        path: "/comments",
        input: { thread: "t1" },
        sendKey: "k-read",
      }),
    ).toEqual({ items: [] });
    expect(journal.get("k-read")).toBeNull();
  });
});

describe("the verdict handler", () => {
  it("no record is `not_sent` before_submit", async () => {
    const { verdict } = build();
    expect(await verdict("k-none")).toMatchObject({
      verdict: "not_sent",
      how: "before_submit",
      reason: "no send under this key",
    });
  });

  it("a final verdict is answered as it stands", async () => {
    const { call, verdict } = build();
    const first = await call(say("final one", "k-f"));
    expect(await verdict("k-f")).toEqual(first);
  });

  it("a call still running is `unknown` 'still running'; once it ends the verdict is read", async () => {
    platform.mode = "hold";
    let release = () => {};
    platform.release = new Promise<void>((ok) => {
      release = ok;
    });
    const { call, verdict } = build();
    const running = call(say("held comment", "k-live"));
    // The leg is past its submit step and waiting.
    await expect.poll(() => journal.get("k-live")?.submitted).toBe(true);
    expect(await verdict("k-live")).toMatchObject({
      verdict: "unknown",
      reason: "the send is still running",
    });
    release();
    expect(await running).toMatchObject({ verdict: "sent", how: "verified" });
    expect(await verdict("k-live")).toMatchObject({ verdict: "sent", how: "verified" });
  });

  it("a call killed after its submit step is read by the verdict handler, which reads at once", async () => {
    // The journal says submitted with no verdict, as after a killed invocation.
    journal.start({
      key: "k-killed",
      site: "scratch",
      method: "POST",
      path: "/comments",
      account: null,
      input: { thread: "t1", text: "killed mid call" },
    });
    journal.submitted("k-killed");
    platform.comments.unshift({ text: "killed mid call", at: new Date().toISOString(), id: "c4" });
    const { verdict, sleeps } = build();
    expect(await verdict("k-killed")).toMatchObject({ verdict: "sent", how: "verified", id: "c4" });
    expect(sleeps).toEqual([]);
  });

  it("an `unknown` verdict is read again; the platform shows it now", async () => {
    platform.mode = "lost";
    platform.lagging = true;
    const { call, verdict } = build();
    await call({ ...VIDEO, input: { title: "late video" }, sendKey: "k-late" });
    showVideos();
    expect(await verdict("k-late")).toMatchObject({
      verdict: "sent",
      how: "verified",
      id: "v:late video",
    });
    // Final now: it stands.
    expect(journal.get("k-late")?.verdict?.verdict).toBe("sent");
    expect(platform.writes).toHaveLength(1);
  });

  it("a started record nothing runs is `not_sent` before_submit", async () => {
    journal.start({
      key: "k-lost",
      site: "scratch",
      method: "POST",
      path: "/comments",
      account: null,
      input: { thread: "t1", text: "x" },
    });
    const { verdict } = build();
    expect(await verdict("k-lost")).toMatchObject({ verdict: "not_sent", how: "before_submit" });
  });
});

describe("the journal", () => {
  it("keeps a final verdict over a later one, and replaces an unknown", () => {
    const j = memorySendJournal();
    j.start({ key: "k", site: "s", method: "POST", path: "/p", account: null, input: {} });
    const unknown: SendVerdict = {
      verdict: "unknown",
      reason: "why",
      since: "2026-10-16T00:00:00Z",
    };
    const sent: SendVerdict = {
      verdict: "sent",
      id: null,
      url: null,
      at: "2026-10-16T00:01:00Z",
      how: "verified",
    };
    const gone: SendVerdict = { verdict: "not_sent", reason: "no", how: "refused" };
    expect(j.settle("k", unknown)).toEqual(unknown);
    expect(j.settle("k", sent)).toEqual(sent);
    expect(j.settle("k", gone)).toEqual(sent);
    expect(j.get("k")?.verdict).toEqual(sent);
  });

  it("ages a record out after 30 days", () => {
    let now = Date.parse("2026-10-16T00:00:00Z");
    const j = fileSendJournal(join(dir, "aged"), () => now);
    j.start({ key: "k", site: "s", method: "POST", path: "/p", account: null, input: {} });
    expect(j.get("k")).not.toBeNull();
    now += 31 * 24 * 3_600_000;
    expect(j.get("k")).toBeNull();
  });

  it("a file that will not parse reads as unknown, so a rerun verifies and never writes", () => {
    const at = join(dir, "torn");
    const j = fileSendJournal(at);
    j.start({ key: "k", site: "s", method: "POST", path: "/p", account: null, input: {} });
    const name = `${createHash("sha256").update("k").digest("hex")}.json`;
    writeFileSync(join(at, name), '{"key":"k","si');
    expect(j.get("k")).toMatchObject({ submitted: true, verdict: { verdict: "unknown" } });
  });

  it("the verify backoff is about 30 s, 3 min and 10 min after the end", () => {
    let t = 0;
    const at = VERIFY_PAUSES_MS.map((p) => (t += p));
    expect(at).toEqual([30_000, 180_000, 600_000]);
  });
});
