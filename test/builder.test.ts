import { describe, expect, it } from "vitest";
import { buildProposals, pickBuildable, recordingNameFor } from "../src/agent/builder.js";
import type { Proposal } from "../src/agent/evaluator.js";
import type { AgentSessions, SessionView } from "../src/agent/sessions.js";

const proposal = (over: Partial<Proposal>): Proposal => ({
  title: "Renew the SSL certificate",
  why: "failed twice",
  site: "cloudflare",
  goal: "renew the certificate for wren-six.com",
  occurrences: 3,
  covered: false,
  ...over,
});

/** An agent whose session ends the way the script says; records what it was asked. */
function fakeAgent(script: Partial<SessionView>) {
  const calls: string[] = [];
  let view: SessionView | null = null;
  const agent: AgentSessions = {
    async start(req) {
      calls.push(`start ${req.site}: ${req.goal}`);
      view = {
        id: "s1",
        site: req.site,
        goal: req.goal,
        inputs: {},
        status: "running",
        prompt: null,
        steps: [],
        achieved: null,
        summary: null,
        error: null,
        recording: null,
        recordingName: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        startedAt: "2026-09-20T00:00:00Z",
        port: 0,
      };
      // Settles on the second look.
      setTimeout(() => Object.assign(view as SessionView, script), 0);
      return view;
    },
    list: () => (view ? [view] : []),
    get: () => view,
    async pause() {
      throw new Error("unused");
    },
    async resume() {
      throw new Error("unused");
    },
    async stop() {
      throw new Error("unused");
    },
    async save(_id, name) {
      calls.push(`save ${name}`);
      return view as SessionView;
    },
    async exec() {
      throw new Error("unused");
    },
    async close() {
      calls.push("close");
      return view as SessionView;
    },
  };
  return { agent, calls };
}

const notes: string[] = [];
const base = (agent: AgentSessions) => ({
  agent,
  notify: async (t: string) => {
    notes.push(t);
  },
  compile: async (name: string) => {
    return { workflow: `wf-${name}` };
  },
  // A real tick: the builder polls, and a promise that resolves at once would never let the fake settle.
  sleep: () => new Promise<void>((r) => setImmediate(r)),
});

describe("pickBuildable", () => {
  it("takes fresh, evidenced, unseen proposals, one per pass by default", () => {
    const seen = new Set(["Old one"]);
    const picked = pickBuildable(
      [
        proposal({ title: "Old one" }),
        proposal({ title: "Covered", covered: true }),
        proposal({ title: "Thin", occurrences: 1 }),
        proposal({ title: "First" }),
        proposal({ title: "Second" }),
      ],
      { ...base(fakeAgent({}).agent), remember: seen },
    );
    expect(picked.map((p) => p.title)).toEqual(["First"]);
  });
});

describe("buildProposals", () => {
  it("explores, saves, compiles and tells when the agent achieved the goal", async () => {
    notes.length = 0;
    const { agent, calls } = fakeAgent({ status: "done", achieved: true, summary: "renewed" });
    const remember = new Set<string>();
    const out = await buildProposals([proposal({})], { ...base(agent), remember });
    expect(out).toEqual([
      {
        title: "Renew the SSL certificate",
        session: "s1",
        workflow: "wf-renew-the-ssl-certificate",
        summary: "renewed",
      },
    ]);
    expect(calls).toEqual([
      "start cloudflare: renew the certificate for wren-six.com",
      "save renew-the-ssl-certificate",
      "close",
    ]);
    expect(notes[0]).toMatch(/built `wf-renew-the-ssl-certificate`/);
    expect(remember.has("Renew the SSL certificate")).toBe(true);
  });
  it("leaves a session that needs a person open and says so", async () => {
    notes.length = 0;
    const { agent, calls } = fakeAgent({ status: "needs-human", prompt: "2FA code" });
    const out = await buildProposals([proposal({})], base(agent));
    expect(out[0]).toMatchObject({ workflow: null, summary: "the agent needs you: 2FA code" });
    expect(calls).not.toContain("close");
    expect(notes[0]).toMatch(/could not build .* Session s1 in Explore/);
  });
  it("closes a session that gave up and does not compile", async () => {
    notes.length = 0;
    const { agent, calls } = fakeAgent({
      status: "done",
      achieved: false,
      summary: "no such page",
    });
    const out = await buildProposals([proposal({})], base(agent));
    expect(out[0]).toMatchObject({ workflow: null, summary: "no such page" });
    expect(calls).toEqual(["start cloudflare: renew the certificate for wren-six.com", "close"]);
  });
});

describe("recordingNameFor", () => {
  it("slugs a title within the recording name rules", () => {
    expect(recordingNameFor("Renew the SSL certificate!")).toBe("renew-the-ssl-certificate");
    expect(recordingNameFor("???")).toBe("proposal");
    expect(recordingNameFor("x".repeat(80))).toHaveLength(48);
  });
});
