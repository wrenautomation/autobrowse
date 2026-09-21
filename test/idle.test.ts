import { describe, expect, it } from "vitest";
import { ec2Port, instanceIdFromMetadata, selfStopper } from "../src/app/box.js";
import { holding, idleTracker, scheduleIdleStop } from "../src/app/idle.js";

const silent = { info() {}, warn() {} } as never;

describe("idle tracker", () => {
  it("is busy while a hold runs and idle from its release", async () => {
    let t = 0;
    const idle = idleTracker(() => t);
    let release!: () => void;
    const p = idle.hold(() => new Promise<void>((r) => (release = r)));
    t = 100;
    expect(idle.busy()).toBe(true);
    release();
    await p;
    expect(idle.busy()).toBe(false);
    expect(idle.idleFor()).toBe(0);
    t = 250;
    expect(idle.idleFor()).toBe(150);
    idle.touch();
    expect(idle.idleFor()).toBe(0);
  });

  it("releases a hold whose work threw", async () => {
    const idle = idleTracker();
    await expect(idle.hold(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(idle.busy()).toBe(false);
  });

  it("holds through every method of a wrapped object", async () => {
    const idle = idleTracker();
    const seen: boolean[] = [];
    const runner = holding(idle, {
      run: async (n: number) => {
        seen.push(idle.busy());
        return n * 2;
      },
    });
    expect(await runner.run(2)).toBe(4);
    expect(seen).toEqual([true]);
    expect(idle.busy()).toBe(false);
  });
});

describe("idle stop", () => {
  function arm(o: { minutes?: number; stop: () => Promise<boolean>; alsoBusy?: () => boolean }) {
    let t = 0;
    const idle = idleTracker(() => t);
    let tick: () => void = () => undefined;
    scheduleIdleStop({
      idle,
      minutes: o.minutes ?? 10,
      stop: o.stop,
      ...(o.alsoBusy ? { alsoBusy: o.alsoBusy } : {}),
      log: silent,
      setInterval: ((fn: () => void) => {
        tick = fn;
        return 0 as never;
      }) as never,
    });
    return {
      idle,
      at: async (ms: number) => {
        t = ms;
        tick();
        await new Promise((r) => setImmediate(r));
      },
    };
  }

  it("stops once the idle span passes, never while held or otherwise busy", async () => {
    let stops = 0;
    let busy = false;
    const s = arm({
      stop: async () => {
        stops++;
        return true;
      },
      alsoBusy: () => busy,
    });
    await s.at(5 * 60_000);
    expect(stops).toBe(0);
    busy = true;
    await s.at(11 * 60_000);
    expect(stops).toBe(0);
    busy = false;
    let release!: () => void;
    const held = s.idle.hold(() => new Promise<void>((r) => (release = r)));
    await s.at(12 * 60_000);
    expect(stops).toBe(0);
    release();
    await held;
    // the release touched: a fresh span starts
    await s.at(13 * 60_000);
    expect(stops).toBe(0);
    await s.at(23 * 60_000);
    expect(stops).toBe(1);
  });

  it("a declined stop restarts the span; a failed one too", async () => {
    const answers: Array<() => boolean> = [
      () => false,
      () => {
        throw new Error("AccessDenied");
      },
      () => true,
    ];
    let asked = 0;
    const s = arm({
      stop: async () => {
        asked++;
        return (answers.shift() as () => boolean)();
      },
    });
    await s.at(10 * 60_000);
    expect(asked).toBe(1);
    await s.at(11 * 60_000);
    expect(asked).toBe(1);
    await s.at(20 * 60_000);
    expect(asked).toBe(2);
    await s.at(30 * 60_000);
    expect(asked).toBe(3);
  });
});

describe("self stopper", () => {
  function port(tag: string | null) {
    const calls: string[] = [];
    return {
      calls,
      ec2: {
        startedBy: async (id: string) => {
          calls.push(`tag ${id}`);
          return tag;
        },
        stop: async (id: string) => {
          calls.push(`stop ${id}`);
        },
      },
    };
  }

  it("leaves a person's box up, stops a deploy's", async () => {
    const person = port("person");
    expect(await selfStopper({ ec2: person.ec2, instanceId: async () => "i-1" })()).toBe(false);
    expect(person.calls).toEqual(["tag i-1"]);
    const deploy = port("deploy");
    expect(await selfStopper({ ec2: deploy.ec2, instanceId: async () => "i-1" })()).toBe(true);
    expect(deploy.calls).toEqual(["tag i-1", "stop i-1"]);
    const untagged = port(null);
    expect(await selfStopper({ ec2: untagged.ec2, instanceId: async () => "i-1" })()).toBe(true);
  });

  it("does nothing off EC2", async () => {
    const p = port("deploy");
    expect(await selfStopper({ ec2: p.ec2, instanceId: async () => null })()).toBe(false);
    expect(p.calls).toEqual([]);
  });

  it("clears the started-by tag before stopping", async () => {
    const sent: string[] = [];
    const client = {
      send: async (cmd: { constructor: { name: string }; input: unknown }) => {
        sent.push(cmd.constructor.name);
        if (cmd.constructor.name === "DescribeInstancesCommand")
          return {
            Reservations: [
              { Instances: [{ Tags: [{ Key: "autobrowse:started-by", Value: "deploy" }] }] },
            ],
          };
        return {};
      },
    } as never;
    const ec2 = ec2Port(client);
    expect(await ec2.startedBy("i-1")).toBe("deploy");
    await ec2.stop("i-1");
    expect(sent).toEqual(["DescribeInstancesCommand", "DeleteTagsCommand", "StopInstancesCommand"]);
  });

  it("reads the instance id over IMDSv2 and gives null when metadata is out of reach", async () => {
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/token")) {
        expect(init?.method).toBe("PUT");
        return new Response("tok");
      }
      expect(
        (init?.headers as Record<string, string> | undefined)?.["X-aws-ec2-metadata-token"],
      ).toBe("tok");
      return new Response("i-0abc\n");
    }) as never;
    expect(await instanceIdFromMetadata(fetchFn)).toBe("i-0abc");
    const down = (async () => {
      throw new Error("EHOSTUNREACH");
    }) as never;
    expect(await instanceIdFromMetadata(down)).toBeNull();
    const denied = (async () => new Response("", { status: 403 })) as never;
    expect(await instanceIdFromMetadata(denied)).toBeNull();
  });
});

describe("pending invocations", () => {
  it("counts queued, running and retrying invocations of the worker's services", async () => {
    const { pendingInvocations } = await import("../src/app/pending.js");
    const seen: Array<{ url: string; query: string; auth: string | undefined }> = [];
    const http = {
      json: async (
        url: string,
        req: { body: { query: string }; headers: Record<string, string> },
      ) => {
        seen.push({ url, query: req.body.query, auth: req.headers.authorization });
        return { ok: true, status: 200, body: { rows: [{ n: "2" }] }, headers: new Headers() };
      },
    } as never;
    const n = await pendingInvocations({
      adminUrl: "https://env.restate.cloud:9070/",
      authToken: "t",
      http,
      services: ["sites", "browser", "it's"],
    });
    expect(n).toBe(2);
    expect(seen[0]?.url).toBe("https://env.restate.cloud:9070/query");
    expect(seen[0]?.auth).toBe("Bearer t");
    expect(seen[0]?.query).toBe(
      "SELECT COUNT(*) AS n FROM sys_invocation WHERE target_service_name IN ('sites', 'browser', 'it''s') AND status IN ('pending', 'ready', 'running', 'backing-off')",
    );
  });

  it("the idle stop waits on a busy answer, async or not", async () => {
    let t = 0;
    const idle = idleTracker(() => t);
    let tick: () => void = () => undefined;
    let stops = 0;
    let queued = 1;
    scheduleIdleStop({
      idle,
      minutes: 1,
      alsoBusy: async () => queued > 0,
      stop: async () => {
        stops++;
        return true;
      },
      log: silent,
      setInterval: ((fn: () => void) => {
        tick = fn;
        return 0 as never;
      }) as never,
    });
    const at = async (ms: number) => {
      t = ms;
      tick();
      await new Promise((r) => setImmediate(r));
    };
    await at(120_000);
    expect(stops).toBe(0);
    queued = 0;
    await at(180_000);
    expect(stops).toBe(1);
  });
});
