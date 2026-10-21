import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { withCall } from "../src/browser/attempt.js";
import {
  defineFlow,
  FlowInterrupted,
  flowRunner,
  type RunnerOptions,
} from "../src/browser/flow.js";
import { fileResumes, keptUrl } from "../src/browser/resume.js";
import { type Screen, walk } from "../src/browser/screens.js";
import { NeedsHuman } from "../src/browser/session.js";
import { memoryFlowRuns } from "../src/runs/flows.js";

/** Three pages: one → two (the site mints a token in the query) → done. */
const PAGES: Record<string, string> = {
  "/1": `<h1>Step one</h1><button onclick="location='/2?job=7&token=minted'">Next</button>`,
  "/2": `<h1>Step two</h1><button onclick="location='/3'">Next</button>`,
  "/3": "<h1>Done</h1>",
};

describe("a stopped call resumes where it stopped", () => {
  const hits: Record<string, number> = {};
  const server = createServer((q, r) => {
    const path = (q.url ?? "/").split("?")[0] as string;
    hits[path] = (hits[path] ?? 0) + 1;
    r.writeHead(200, { "content-type": "text/html" }).end(`<title>t</title>${PAGES[path] ?? ""}`);
  });
  const ready = new Promise<string>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
  afterAll(() => server.close());

  const dir = mkdtempSync(join(tmpdir(), "autobrowse-resume-"));
  const browser = {
    tier: "local" as const,
    channel: "chromium" as const,
    profilesDir: join(dir, "profiles"),
    artifactsDir: join(dir, "artifacts"),
    headless: true,
  };
  let ones = 0;
  let stopOnTwo = true;
  const screens: Screen[] = [
    {
      name: "done",
      looks: "the done page",
      shows: [{ role: "heading", name: "Done" }],
      goal: true,
    },
    {
      name: "two",
      looks: "step two",
      shows: [{ role: "heading", name: "Step two" }],
      act: async ({ fp }) => {
        if (stopOnTwo) fp.human("check step two");
        await fp.act({ kind: "click" }, { role: "button", name: "Next" }, { goal: "next on two" });
      },
    },
    {
      name: "one",
      looks: "step one",
      shows: [{ role: "heading", name: "Step one" }],
      act: async ({ fp }) => {
        ones += 1;
        await fp.act({ kind: "click" }, { role: "button", name: "Next" }, { goal: "next on one" });
      },
    },
  ];
  const apply = (url: string) =>
    defineFlow<undefined, string>({
      site: "scratch",
      name: "apply",
      async run(fp) {
        await fp.open(`${url}/1?job=7`);
        return walk({ fp }, { site: "scratch", name: "apply", goal: "applied", screens });
      },
    });

  it("reruns at screen 2, not screen 1; success clears the record", async () => {
    const url = await ready;
    const resumes = fileResumes(join(dir, "resume"));
    const runner = flowRunner(browser, { pace: null, runs: null, resume: resumes });
    const flow = apply(url);
    ones = 0;
    stopOnTwo = true;
    await expect(withCall("inv-1 apply", () => runner.run(flow, undefined))).rejects.toBeInstanceOf(
      NeedsHuman,
    );
    expect(ones).toBe(1);
    // The minted token is gone; the caller's own `job` stays.
    expect(resumes.get("inv-1 apply")).toMatchObject({
      url: `${url}/2?job=7`,
      profile: "scratch",
      screensDone: { "scratch/apply": ["one"] },
    });
    const [file] = readdirSync(join(dir, "resume"));
    expect(statSync(join(dir, "resume", file as string)).mode & 0o777).toBe(0o600);

    stopOnTwo = false;
    const ones1 = hits["/1"];
    await expect(withCall("inv-1 apply", () => runner.run(flow, undefined))).resolves.toBe("done");
    expect(ones).toBe(1);
    expect(hits["/1"]).toBe(ones1);
    expect(resumes.get("inv-1 apply")).toBeNull();
    expect(readdirSync(join(dir, "resume"))).toEqual([]);
  }, 90_000);

  it("resume: false starts over at screen 1", async () => {
    const url = await ready;
    const runner = flowRunner(browser, { pace: null, runs: null, resume: false });
    const flow = apply(url);
    ones = 0;
    stopOnTwo = true;
    await expect(withCall("inv-2 apply", () => runner.run(flow, undefined))).rejects.toBeInstanceOf(
      NeedsHuman,
    );
    stopOnTwo = false;
    await withCall("inv-2 apply", () => runner.run(flow, undefined));
    expect(ones).toBe(2);
  }, 90_000);

  it("a resumed try that fails in place drops the record; the next try starts at step 1", async () => {
    const url = await ready;
    const resumes = fileResumes(join(dir, "resume-drop"));
    const runner = flowRunner(browser, { pace: null, runs: null, resume: resumes });
    stopOnTwo = true;
    await expect(
      withCall("inv-3 apply", () => runner.run(apply(url), undefined)),
    ).rejects.toThrow();
    expect(resumes.get("inv-3 apply")?.url).toBe(`${url}/2?job=7`);
    // A hand-written flow that expects page one: the saved page breaks it.
    const strict = defineFlow<undefined, void>({
      site: "scratch",
      name: "apply",
      async run(fp) {
        await fp.open(`${url}/1?job=7`);
        if (!(await fp.has({ role: "heading", name: "Step one" }))) throw new Error("not on one");
      },
    });
    await expect(withCall("inv-3 apply", () => runner.run(strict, undefined))).rejects.toThrow(
      /not on one/,
    );
    expect(resumes.get("inv-3 apply")).toBeNull();
  }, 90_000);

  it("a run with no call key keeps nothing", async () => {
    const url = await ready;
    const resumes = fileResumes(join(dir, "resume-none"));
    const runner = flowRunner(browser, { pace: null, runs: null, resume: resumes });
    stopOnTwo = true;
    await expect(runner.run(apply(url), undefined)).rejects.toBeInstanceOf(NeedsHuman);
    expect(existsSync(join(dir, "resume-none"))).toBe(false);
  }, 90_000);
});

describe("the kept URL", () => {
  it("is origin and path, plus only the query keys the run's first URL carried", () => {
    expect(keptUrl("https://a.test/apply/2?job=7&token=x#f", "https://a.test/apply?job=7")).toBe(
      "https://a.test/apply/2?job=7",
    );
    expect(keptUrl("https://a.test/apply/2?job=7", "https://b.test/?job=7")).toBe(
      "https://a.test/apply/2",
    );
    expect(keptUrl("about:blank", null)).toBeNull();
    expect(keptUrl("chrome-error://chromewebdata/", null)).toBeNull();
  });
});

describe("the open-failure row", () => {
  const run = async (opts: Partial<RunnerOptions> & { cdpUrl?: string }) => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-open-"));
    const runs = memoryFlowRuns();
    const runner = flowRunner(
      {
        tier: "cdp",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
        ...(opts.cdpUrl ? { cdpUrl: opts.cdpUrl } : {}),
      },
      { pace: null, runs },
    );
    const flow = defineFlow<undefined, void>({ site: "scratch", name: "go", run: async () => {} });
    const err = await runner.run(flow, undefined).catch((e: unknown) => e);
    return { err, rows: runs.rows };
  };

  it("a browser that will not open writes a failed row", async () => {
    const { err, rows } = await run({});
    expect(err).toBeInstanceOf(Error);
    expect(rows).toEqual([
      expect.objectContaining({
        site: "scratch",
        flow: "go",
        outcome: "failed",
        goal: "open the browser",
        acts: 0,
        submitted: false,
        error: expect.stringMatching(/BROWSER_CDP_URL/),
      }),
    ]);
  });

  it("a browser the network cut off writes an interrupted row", async () => {
    const { err, rows } = await run({ cdpUrl: "http://127.0.0.1:1" });
    expect(err).toBeInstanceOf(FlowInterrupted);
    expect(rows[0]).toMatchObject({ outcome: "interrupted", goal: "open the browser", acts: 0 });
  }, 60_000);
});
