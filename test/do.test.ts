import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentSessions, SessionView } from "../src/agent/sessions.js";
import { abilitiesOf, fieldLine, fieldsOf, parseSiteAbility } from "../src/do/catalog.js";
import { type DoerDeps, doer, missingWorkflowName, recordingNameOf } from "../src/do/doer.js";
import { pickAbility } from "../src/do/pick.js";
import { defineWorkflow, done } from "../src/engine/workflow.js";
import { fakeLlm } from "../src/llm/fake.js";
import type { SiteRow } from "../src/sites/facade.js";
import type { SiteApi } from "../src/sites/types.js";

const upload = z.object({ file: z.string(), title: z.string() });
const api: SiteApi = {
  site: "tube",
  origin: "https://tube.test",
  auth: { token: "TUBE_TOKEN" },
  routes: [
    {
      method: "POST",
      path: "/v1/videos",
      request: upload,
      summary: "upload a video",
      irreversible: true,
      api: async () => ({}),
    },
    {
      method: "GET",
      path: "/v1/videos",
      request: z.object({}),
      summary: "list videos",
      browser: { workflow: "tube-list-videos" },
    },
  ],
  setup: [],
};
const rows: SiteRow[] = [
  {
    site: "tube",
    origin: "https://tube.test",
    authed: true,
    routes: [
      {
        method: "POST",
        path: "/v1/videos",
        summary: "upload a video",
        via: "api",
        irreversible: true,
      },
      {
        method: "GET",
        path: "/v1/videos",
        summary: "list videos",
        via: "none",
        missing: "workflow tube-list-videos not recorded",
        irreversible: false,
      },
    ],
    setup: [],
  },
];
const rename = defineWorkflow<unknown, Record<string, never>>()({
  name: "google-name",
  description: "change the account's display name",
  plan: z.object({ dryRun: z.boolean().default(false), name: z.string() }),
  steps: [{ name: "set", irreversible: false, run: async () => done("set") }],
  emptyMemo: () => ({}),
});

describe("abilities", () => {
  it("lists site routes with their live readiness, workflows with plan fields, flows", () => {
    const list = abilitiesOf({
      sites: { apis: [api], rows },
      workflows: [rename],
      flows: ["google/oauth-consent"],
    });
    expect(
      list.map((a) => [a.kind, a.name, a.ready, a.inputs.map((f) => f.name), a.irreversible]),
    ).toEqual([
      ["site", "tube POST /v1/videos", true, ["file", "title"], true],
      ["site", "tube GET /v1/videos", false, [], false],
      ["workflow", "google-name", true, ["name"], false],
      ["flow", "google/oauth-consent", true, [], false],
    ]);
    expect(list[1]?.missing).toBe("workflow tube-list-videos not recorded");
    expect(fieldsOf(z.string())).toEqual([]);
    const fields = fieldsOf(
      z.object({
        resource: z.enum(["videos", "channels"]),
        part: z.string().optional(),
        mine: z.boolean().default(true),
      }),
      "/v3/{resource}",
    );
    expect(fields).toEqual([
      { name: "resource", inPath: true, values: ["videos", "channels"], type: "enum" },
      { name: "part", type: "string" },
      { name: "mine", type: "boolean" },
    ]);
    expect(fields.map(fieldLine)).toEqual([
      "resource (path: videos|channels)",
      "part",
      "mine (boolean)",
    ]);
    expect(parseSiteAbility("tube POST /v1/videos")).toEqual({
      site: "tube",
      method: "POST",
      path: "/v1/videos",
    });
    expect(parseSiteAbility("google-name")).toBeNull();
    expect(missingWorkflowName("workflow tube-list-videos not recorded")).toBe("tube-list-videos");
    expect(missingWorkflowName("flow x/y not recorded")).toBeNull();
    expect(recordingNameOf("Upload this to YouTube!")).toBe("upload-this-to-youtube");
    expect(recordingNameOf("!!!")).toBe("do-goal");
  });
});

describe("pick", () => {
  const list = abilitiesOf({ sites: { apis: [api], rows }, workflows: [rename] });

  it("an exact name needs no model; without one everything else is the agent's", async () => {
    const exact = await pickAbility(null, { goal: "google-name", inputs: { name: "Wren" } }, list, [
      "google",
    ]);
    expect(exact.ability?.name).toBe("google-name");
    expect(exact.input).toEqual({ name: "Wren" });
    expect(exact.site).toBe("scratch");
    const none = await pickAbility(null, { goal: "rename me", inputs: {}, site: "google" }, list, [
      "google",
    ]);
    expect(none).toMatchObject({ ability: null, site: "google", why: "no model" });
  });

  it("the model maps a goal onto an ability and its input, or names the site to explore", async () => {
    const llm = fakeLlm([
      {
        ability: "tube POST /v1/videos",
        input: { file: "/tmp/a.mp4", title: "Hello" },
        why: "an upload",
      },
      { ability: null, site: "linkedin", why: "no linkedin ability" },
      { ability: "made-up", input: {}, site: "mars" },
    ]);
    const up = await pickAbility(
      llm,
      { goal: "upload this to tube titled Hello", inputs: { file: "/tmp/a.mp4" } },
      list,
      ["google", "linkedin"],
    );
    expect(up.ability?.name).toBe("tube POST /v1/videos");
    expect(up.input).toEqual({ file: "/tmp/a.mp4", title: "Hello" });
    expect(up.site).toBe("tube");
    expect(llm.requests[0]?.prompt).toContain("- file = /tmp/a.mp4");
    expect(llm.requests[0]?.prompt).toContain(
      "(not ready: workflow tube-list-videos not recorded)",
    );
    const none = await pickAbility(llm, { goal: "post on linkedin", inputs: {} }, list, [
      "google",
      "linkedin",
    ]);
    expect(none).toMatchObject({ ability: null, site: "linkedin" });
    // A name not in the list, a site not known: nothing picked, scratch.
    const bad = await pickAbility(llm, { goal: "x", inputs: {} }, list, ["google"]);
    expect(bad).toMatchObject({ ability: null, site: "scratch" });
  });
});

function fakeAgent(script: Partial<SessionView>) {
  const calls: string[] = [];
  let view: SessionView | null = null;
  const agent: AgentSessions = {
    async start(req) {
      calls.push(`start ${req.site}: ${req.goal} ${JSON.stringify(req.inputs ?? {})}`);
      view = {
        id: "s1",
        site: req.site,
        goal: req.goal,
        inputs: req.inputs ?? {},
        status: "running",
        prompt: null,
        steps: [],
        achieved: null,
        summary: null,
        error: null,
        recording: null,
        recordingName: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        startedAt: "2026-09-21T00:00:00Z",
        port: 0,
      };
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

const deps = (over: Partial<DoerDeps> = {}): DoerDeps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    llm: null,
    abilities: async () =>
      abilitiesOf({
        sites: { apis: [api], rows },
        workflows: [rename],
        flows: ["google/oauth-consent"],
      }),
    sites: async () => ["google", "tube"],
    callSite: async (site, method, path, input) => {
      calls.push(`site ${site} ${method} ${path} ${JSON.stringify(input)}`);
      return { id: "v1" };
    },
    runWorkflow: async (name, plan) => {
      calls.push(`workflow ${name} ${JSON.stringify(plan)}`);
      return {
        status: "done",
        steps: [{ name: "set", status: "done", detail: '{"name":"Wren"}' }],
        output: { name: "Wren" },
      };
    },
    runFlow: async (name, input) => {
      calls.push(`flow ${name} ${JSON.stringify(input)}`);
      return { landed: "x" };
    },
    sleep: () => new Promise<void>((r) => setTimeout(r, 0)),
    ...over,
  };
};

describe("do", () => {
  it("runs the ability the goal names: a site route, a workflow, a flow", async () => {
    const d = deps();
    const verb = doer(d);
    const site = await verb.do({ goal: "tube POST /v1/videos", inputs: { file: "a", title: "t" } });
    expect(site).toMatchObject({
      via: "site",
      name: "tube POST /v1/videos",
      status: "done",
      output: { id: "v1" },
      built: null,
    });
    const wf = await verb.do({ goal: "google-name", inputs: { name: "Wren" } });
    expect(wf).toMatchObject({
      via: "workflow",
      status: "done",
      output: { name: "Wren" },
      summary: "google-name done: set done",
    });
    const flow = await verb.do({ goal: "google/oauth-consent" });
    expect(flow).toMatchObject({ via: "flow", status: "done", output: { landed: "x" } });
    expect(d.calls).toEqual([
      'site tube POST /v1/videos {"file":"a","title":"t"}',
      'workflow google-name {"name":"Wren"}',
      "flow google/oauth-consent {}",
    ]);
    await expect(verb.do({ goal: "  " })).rejects.toMatchObject({ status: 400 });
  });

  it("runs in its own owner's accounts: no owner or its own runs, another owner is refused", async () => {
    const d = deps();
    const verb = doer(d);
    await expect(verb.do({ goal: "google-name", owner: "wren" })).resolves.toMatchObject({
      status: "done",
    });
    await expect(verb.do({ goal: "google-name", owner: null })).resolves.toMatchObject({
      status: "done",
    });
    await expect(verb.do({ goal: "google-name", owner: "acme" })).rejects.toMatchObject({
      status: 409,
    });
    const theirs = doer({ ...deps(), owner: "acme" });
    await expect(theirs.do({ goal: "google-name", owner: "acme" })).resolves.toMatchObject({
      status: "done",
    });
    await expect(theirs.do({ goal: "google-name", owner: "wren" })).rejects.toMatchObject({
      status: 409,
    });
    expect(d.calls).toEqual(["workflow google-name {}", "workflow google-name {}"]);
  });

  it("fills a route's {param} segments from the input, or says which are missing", async () => {
    const d = deps({
      abilities: async () =>
        abilitiesOf({
          sites: {
            apis: [
              {
                ...api,
                routes: [
                  {
                    method: "GET",
                    path: "/v1/{resource}/{id}",
                    request: z.object({ resource: z.string(), id: z.string() }),
                    summary: "one",
                  },
                ],
              },
            ],
            rows: [
              {
                ...(rows[0] as SiteRow),
                routes: [
                  {
                    method: "GET",
                    path: "/v1/{resource}/{id}",
                    summary: "one",
                    via: "api",
                    irreversible: false,
                  },
                ],
              },
            ],
          },
        }),
    });
    const verb = doer(d);
    await verb.do({
      goal: "tube GET /v1/{resource}/{id}",
      inputs: { resource: "videos", id: "a b" },
    });
    expect(d.calls).toEqual(['site tube GET /v1/videos/a%20b {"resource":"videos","id":"a b"}']);
    await expect(
      verb.do({ goal: "tube GET /v1/{resource}/{id}", inputs: { resource: "videos" } }),
    ).rejects.toThrow(/needs \{id\}/);
  });

  it("a dry run says what would run and runs nothing", async () => {
    const d = deps({
      llm: fakeLlm([
        { ability: "tube POST /v1/videos", input: { file: "a", title: "t" }, why: "upload" },
      ]),
    });
    const out = await doer(d).do({ goal: "upload a to tube", inputs: { file: "a" }, dryRun: true });
    expect(out).toMatchObject({
      via: "site",
      name: "tube POST /v1/videos",
      status: "planned",
      input: { file: "a", title: "t" },
    });
    expect(out.summary).toMatch(/^would run tube POST/);
    expect(d.calls).toEqual([]);
  });

  it("with nothing ready and no model it says so; with a model but no agent, 501", async () => {
    await expect(doer(deps()).do({ goal: "list tube videos" })).rejects.toMatchObject({
      status: 501,
    });
  });

  it("nothing ready: the agent explores, and the recording is compiled under the missing leg's name", async () => {
    const { agent, calls } = fakeAgent({
      status: "done",
      achieved: true,
      summary: "listed 3 videos",
    });
    const compiled: string[] = [];
    const d = deps({
      llm: fakeLlm([{ ability: "tube GET /v1/videos", input: {}, why: "the list" }]),
      agent,
      compile: async (name) => {
        compiled.push(name);
        return { workflow: name };
      },
    });
    const out = await doer(d).do({ goal: "list my tube videos" });
    expect(out).toMatchObject({
      via: "agent",
      name: "tube-list-videos",
      status: "done",
      built: "tube-list-videos",
      session: "s1",
      output: "listed 3 videos",
    });
    expect(out.summary).toContain("compiled as tube-list-videos");
    expect(calls).toEqual(["start tube: list my tube videos {}", "save tube-list-videos", "close"]);
    expect(compiled).toEqual(["tube-list-videos"]);
    expect(d.calls).toEqual([]);
  });

  it("a goal nothing covers explores the picked site and is saved under the goal's name", async () => {
    const { agent, calls } = fakeAgent({ status: "done", achieved: true, summary: "renamed" });
    const d = deps({
      llm: fakeLlm([{ ability: null, site: "google", why: "nothing renames" }]),
      agent,
      compile: async (name) => ({ workflow: name }),
    });
    const out = await doer(d).do({
      goal: "Rename my Google account",
      inputs: { name: "Wren" },
      url: "https://myaccount.google.com",
    });
    expect(out.built).toBe("rename-my-google-account");
    expect(calls[0]).toBe('start google: Rename my Google account {"name":"Wren"}');
  });

  it("the agent needing a person leaves the session open; a failed session closes it", async () => {
    const needs = fakeAgent({ status: "needs-human", prompt: "solve the puzzle" });
    const out = await doer(
      deps({ llm: fakeLlm([{ ability: null, site: "tube" }]), agent: needs.agent }),
    ).do({ goal: "x" });
    expect(out).toMatchObject({ via: "agent", status: "needs-human", session: "s1", built: null });
    expect(out.summary).toContain("solve the puzzle");
    expect(needs.calls).toEqual(["start tube: x {}"]);
    const failed = fakeAgent({ status: "failed", error: "budget spent" });
    const bad = await doer(
      deps({ llm: fakeLlm([{ ability: null, site: null }]), agent: failed.agent }),
    ).do({ goal: "x" });
    expect(bad).toMatchObject({ status: "failed", summary: "budget spent" });
    expect(failed.calls).toEqual(["start scratch: x {}", "close"]);
  });

  it("a gated workflow answers needs-human", async () => {
    const d = deps({
      runWorkflow: async () => ({
        status: "waiting",
        steps: [{ name: "buy", status: "waiting", detail: "gate" }],
        output: null,
      }),
    });
    const out = await doer(d).do({ goal: "google-name", inputs: { name: "x" } });
    expect(out).toMatchObject({ status: "needs-human", output: "gate" });
  });
});
