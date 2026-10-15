/**
 * A busy profile under a real Restate and a real browser: an explore session holds the profile,
 * a post-like write on it waits (durable sleeps), then runs once when the session closes; an
 * idle session gives its profile to the write at once; a profile held past the bound goes back
 * `not sent` under 503. Needs Docker and Playwright's chromium.
 */

import { symlinkSync, unlinkSync, utimesSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listProcs } from "../src/browser/reap.js";
import { type BrowserOptions, openSession } from "../src/browser/session.js";
import { startExplore } from "../src/explore/server.js";
import type { SiteFacade } from "../src/sites/facade.js";
import { sitesService } from "../src/sites/index.js";

const NAME = "sites_waittest";
let dir: string;
let browser: BrowserOptions;
/** Each time the write got its browser: the post it would make. */
const posts: string[] = [];

/** A site whose one write opens the profile's browser, as a browser leg does, and "posts". */
const facade: SiteFacade = {
  list: async () => [],
  status: async (site) => ({ site, origin: "o", authed: true, routes: [], setup: [] }),
  call: async (_site, _method, path) => {
    const s = await openSession("scratch", browser);
    try {
      posts.push(path);
      return { posted: path };
    } finally {
      await s.close();
    }
  },
  setup: async () => ({ made: [] }),
  caps: () => ({ day: "2026-10-15", used: {}, calls: [] }),
};

let env: RestateTestEnvironment;
const container = () => {
  const c = new RestateContainer();
  (c as unknown as { hostConfig: { AutoRemove?: boolean } }).hostConfig.AutoRemove = true;
  return c
    .withAutoRemove(false)
    .withEntrypoint(["timeout", "-s", "KILL", "30m", "/usr/local/bin/restate-server"])
    .withCommand([])
    .alwaysReplay();
};

/** An explore session on the profile, its files where real ones live, so the profile's owner reads `explore:<port>`. */
async function explore() {
  const port = 9700 + Math.floor(Math.random() * 200);
  const tokenFile = join(tmpdir(), "autobrowse", `explore-${port}.token`);
  const s = await startExplore({
    site: "scratch",
    port,
    tokenFile,
    recordingsDir: join(dir, "recordings"),
    browser,
  });
  const send = (cmd: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.token}` },
      body: JSON.stringify(cmd),
    });
  await send({ cmd: "open", url: "data:text/html,<p>draft</p>" });
  // Headless shell leaves no `SingletonLock`; real Chrome does (`<host>-<pid>`). Leave the one it would.
  const profileDir = join(dir, "profiles", "scratch");
  const chrome = (await listProcs()).find(
    (p) => p.command.includes(profileDir) && /chrom/i.test(p.command) && !/--type=/.test(p.command),
  );
  if (!chrome) throw new Error("the explore session's browser is not running");
  try {
    unlinkSync(join(profileDir, "SingletonLock")); // the last session's, now dangling
  } catch {}
  symlinkSync(`${hostname()}-${chrome.pid}`, join(profileDir, "SingletonLock"));
  return { ...s, port, info: tokenFile.replace(/\.token$/, ".json"), send };
}

const post = (path: string) =>
  clients
    .connect({ url: env.baseUrl() })
    .serviceClient<{ call: (r: unknown) => Promise<unknown> }>({ name: NAME })
    .call({ site: "scratch", method: "POST", path, input: {} });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "profile-wait-"));
  browser = {
    tier: "local",
    channel: "chromium",
    profilesDir: join(dir, "profiles"),
    artifactsDir: join(dir, "artifacts"),
    headless: true,
  } as BrowserOptions;
  const start = () =>
    RestateTestEnvironment.start({
      services: [
        sitesService(facade, NAME, undefined, null, {
          wait: { boundMs: 8_000, pausesMs: [1_000] },
        }),
      ],
      container,
      serviceEndpointAccess: "docker-host",
    });
  env = await start().catch(start);
}, 180_000);
afterAll(async () => {
  await env?.stop();
  await new Promise((r) => setTimeout(r, 500)); // Chrome still flushes its profile
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("a write on a busy profile", () => {
  it("waits while an explore session drives it, then runs once when it closes", async () => {
    const ex = await explore();
    const write = post("/web/posts/1");
    await new Promise((r) => setTimeout(r, 3_000));
    expect(posts).toEqual([]);
    await ex.send({ cmd: "close", keep: true });
    await ex.done;
    expect(await write).toEqual({ posted: "/web/posts/1" });
    expect(posts).toEqual(["/web/posts/1"]);
  });

  it("takes the profile from an idle session, closing it", async () => {
    const ex = await explore();
    const old = new Date(Date.now() - 4 * 60_000);
    utimesSync(ex.info, old, old);
    const t0 = Date.now();
    expect(await post("/web/posts/2")).toEqual({ posted: "/web/posts/2" });
    expect(Date.now() - t0).toBeLessThan(15_000);
    await ex.done; // the session ended: the write closed it
    expect(posts).toEqual(["/web/posts/1", "/web/posts/2"]);
  });

  it("past the bound goes back not sent, under 503, and posts nothing", async () => {
    const ex = await explore();
    const err = await post("/web/posts/3").catch((e: unknown) => e);
    // What a caller over HTTP reads: the status, and the words that say nothing left.
    expect(err).toMatchObject({ status: 503 });
    expect(JSON.parse((err as { responseText: string }).responseText)).toMatchObject({
      code: 503,
      message: expect.stringMatching(
        /^not sent: profile scratch is busy \(explore:\d+\); waited 8 s for it, try again$/,
      ),
    });
    expect(posts).toEqual(["/web/posts/1", "/web/posts/2"]);
    await ex.send({ cmd: "close", keep: true });
    await ex.done;
  });
});
