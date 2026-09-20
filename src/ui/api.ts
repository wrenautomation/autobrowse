/**
 * The HTTP face of a worker: runs, gates, live events, recordings,
 * compile, and an inbound hook that takes what a person typed on any
 * channel. Thin on purpose: every mutation is one Restate call, every
 * body is validated, and every file served is checked to live under the
 * directory it claims. Reads are open when no token is set (local use);
 * with a token, everything needs it.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { proposeWorkflows, readFailures } from "../agent/evaluator.js";
import { readFailure, repairRequest } from "../agent/repair.js";
import type { AgentSessions } from "../agent/sessions.js";
import type { Ingress } from "../app/client.js";
import type { FailureRecord } from "../browser/session.js";
import { parseCommand } from "../channels/commands.js";
import type { Compiled } from "../compiler/index.js";
import type { GateName } from "../engine/effects.js";
import type { RunEvent } from "../engine/events.js";
import type { RunRow } from "../engine/registry.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import { commandSchema } from "../explore/server.js";
import type { Llm } from "../llm/types.js";
import { listRecordings, loadRecording, recordingDir } from "../recorder/store.js";
import type { Recording } from "../recorder/types.js";
import { bearerAuth, rateLimit } from "./auth.js";
import type { EventBus } from "./bus.js";

export interface ApiDeps {
  workflows: readonly AnyWorkflow[];
  ingress: Ingress;
  bus: EventBus;
  recordingsDir: string;
  artifactsDir: string;
  compile(rec: Recording): Promise<Compiled>;
  token: string | undefined;
  /** Agent sessions (explore by model with play/pause); absent when no model is configured. */
  agent?: AgentSessions;
  /** The model the evaluator uses; absent when none is configured. */
  llm?: Llm;
}

const agentStart = z.object({
  site: z.string().regex(/^[a-z][a-z0-9-]*(@[a-z0-9][a-z0-9.@_-]*)?$/i),
  goal: z.string().min(1).max(2000),
  inputs: z.record(z.string(), z.string()).optional(),
  maxSteps: z.number().int().min(1).max(200).optional(),
  url: z.string().url().optional(),
});
const AGENT_ACTIONS = ["pause", "resume", "stop", "save", "close"] as const;
const agentAction = z.object({ name: z.string().optional() });
const repairBody = z.object({ failure: z.string().min(1), goal: z.string().max(2000).optional() });

const ACTIONS = ["approve", "reject", "pause", "play", "reset"] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (s: string): s is Action => (ACTIONS as readonly string[]).includes(s);
const actionBody = z.object({
  name: z.enum(["purchase", "human"]).optional(),
  note: z.string().max(2000).optional(),
});
const inboundBody = z.object({ text: z.string().min(1).max(2000), from: z.string().optional() });
const NAME = /^[a-z][a-z0-9-]*$/;
const KEY = /^[a-z0-9][a-z0-9.@_-]*$/i;

const MIME: Record<string, string> = {
  png: "image/png",
  zip: "application/zip",
  log: "text/plain",
  json: "application/json",
};

/** A file response only when `file` resolves inside `root`. */
function serveUnder(root: string, file: string): Response | null {
  const base = resolve(root);
  const full = resolve(root, file);
  if (full !== base && !full.startsWith(base + sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  const ext = full.split(".").pop() ?? "";
  return new Response(Readable.toWeb(createReadStream(full)) as ReadableStream, {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
    },
  });
}

export function api(deps: ApiDeps): Hono {
  const app = new Hono();
  const byName = new Map(deps.workflows.map((w) => [w.name, w]));
  const runOf = (workflow: string, key: string) => deps.ingress.run(workflow, key);

  app.use("/api/*", bearerAuth(deps.token));
  app.use("/hooks/*", bearerAuth(deps.token), rateLimit({ perMinute: 60 }));

  app.get("/api/workflows", (c) =>
    c.json(
      deps.workflows.map((w) => ({
        name: w.name,
        description: w.description,
        steps: w.steps.map((s) => ({ name: s.name, irreversible: s.irreversible ?? false })),
        plan: z.toJSONSchema(w.plan, { io: "input", unrepresentable: "any" }),
      })),
    ),
  );

  app.get("/api/runs", async (c) => c.json(await deps.ingress.registry().list()));

  app.get("/api/runs/:workflow/:key", async (c) => {
    const { workflow, key } = c.req.param();
    if (!byName.has(workflow)) return c.json({ error: "unknown workflow" }, 404);
    return c.json(await runOf(workflow, key).status());
  });

  app.post("/api/runs/:workflow/:key", async (c) => {
    const { workflow, key } = c.req.param();
    const w = byName.get(workflow);
    if (!w) return c.json({ error: "unknown workflow" }, 404);
    if (!KEY.test(key)) return c.json({ error: "bad key" }, 400);
    const body = await c.req.json().catch(() => null);
    const plan = w.plan.safeParse(body?.plan ?? null);
    if (!plan.success) return c.json({ error: "bad plan", issues: plan.error.issues }, 400);
    await runOf(workflow, key).run(plan.data);
    return c.json({ ok: true }, 202);
  });

  app.post("/api/runs/:workflow/:key/:action", async (c) => {
    const { workflow, key, action } = c.req.param();
    if (!byName.has(workflow)) return c.json({ error: "unknown workflow" }, 404);
    if (!isAction(action)) return c.json({ error: "unknown action" }, 404);
    const body = actionBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!body.success) return c.json({ error: "bad body", issues: body.error.issues }, 400);
    const run = runOf(workflow, key);
    if (action === "approve" || action === "reject") {
      const name = body.data.name ?? (await run.status()).gate?.name;
      if (!name) return c.json({ error: "no open gate" }, 409);
      const args = { name: name as GateName, ...(body.data.note ? { note: body.data.note } : {}) };
      return c.json(action === "approve" ? await run.approve(args) : await run.reject(args));
    }
    await run[action]();
    return c.json({ ok: true });
  });

  /** Live feed: everything since `after`, then each new event; a comment every 15s keeps proxies awake. */
  app.get("/api/events", (c) => {
    const after = Number(c.req.query("after") ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      const send = (seq: number, event: RunEvent) =>
        stream.writeSSE({ id: String(seq), event: event.type, data: JSON.stringify(event) });
      // Subscribe first so nothing lands between the replay and the live feed; hold those until the replay is out.
      let replaying = true;
      let last = after;
      const held: Array<[number, RunEvent]> = [];
      const unsubscribe = deps.bus.subscribe((seq, event) => {
        if (replaying) held.push([seq, event]);
        else void send(seq, event);
      });
      for (const e of deps.bus.recent(after)) {
        await send(e.seq, e.event);
        last = e.seq;
      }
      for (const [seq, event] of held) if (seq > last) await send(seq, event);
      replaying = false;
      let open = true;
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      while (open) {
        await stream.sleep(15_000);
        if (open) await stream.write(": keepalive\n\n");
      }
    });
  });

  app.get("/api/recordings", async (c) => c.json(await listRecordings(deps.recordingsDir)));

  app.get("/api/recordings/:name", async (c) => {
    const { name } = c.req.param();
    if (!NAME.test(name)) return c.json({ error: "bad name" }, 400);
    try {
      return c.json(await loadRecording(deps.recordingsDir, name));
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.get("/api/recordings/:name/files/*", (c) => {
    const { name } = c.req.param();
    if (!NAME.test(name)) return c.json({ error: "bad name" }, 400);
    const rel = c.req.path.split(`/files/`).slice(1).join("/files/");
    return (
      serveUnder(recordingDir(deps.recordingsDir, name), decodeURIComponent(rel)) ??
      c.json({ error: "not found" }, 404)
    );
  });

  app.post("/api/recordings/:name/compile", async (c) => {
    const { name } = c.req.param();
    if (!NAME.test(name)) return c.json({ error: "bad name" }, 400);
    const rec = await loadRecording(deps.recordingsDir, name).catch(() => null);
    if (!rec) return c.json({ error: "not found" }, 404);
    return c.json(await deps.compile(rec));
  });

  /** Gate screenshots and traces live under the artifacts dir; the status gives absolute paths. */
  app.get("/api/artifacts", (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    return serveUnder(deps.artifactsDir, resolve(path)) ?? c.json({ error: "not found" }, 404);
  });

  app.get("/api/agent", (c) => c.json(deps.agent?.list() ?? []));
  /** The evaluator: which recurring needs deserve a workflow, from failures, sessions and recordings. */
  app.get("/api/agent/proposals", async (c) => {
    if (!deps.llm) return c.json({ error: "no model configured: set LLM_PROVIDER" }, 503);
    const recordings = (await listRecordings(deps.recordingsDir)).map((r) => ({
      name: r.name,
      site: r.site,
    }));
    try {
      return c.json(
        await proposeWorkflows(deps.llm, {
          failures: readFailures(deps.artifactsDir),
          sessions: deps.agent?.list() ?? [],
          recordings,
        }),
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });
  /** A failed step's record → an agent session on that page toward the flow's goal. */
  app.post("/api/agent/repair", async (c) => {
    if (!deps.agent) return c.json({ error: "no model configured: set LLM_PROVIDER" }, 503);
    const body = repairBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "failure path required" }, 400);
    let record: FailureRecord;
    try {
      record = readFailure(body.data.failure, deps.artifactsDir);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.json(await deps.agent.start(repairRequest(record, body.data.goal)), 201);
  });
  app.post("/api/agent", async (c) => {
    if (!deps.agent) return c.json({ error: "no model configured: set LLM_PROVIDER" }, 503);
    const parsed = agentStart.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: parsed.error.issues[0]?.message ?? "bad body" }, 400);
    const { url, inputs, maxSteps, ...rest } = parsed.data;
    return c.json(
      await deps.agent.start({
        ...rest,
        ...(inputs ? { inputs } : {}),
        ...(maxSteps ? { maxSteps } : {}),
        url: url ?? null,
      }),
      201,
    );
  });
  app.get("/api/agent/:id", (c) => {
    const view = deps.agent?.get(c.req.param("id"));
    return view ? c.json(view) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/agent/:id/shot/:n", (c) => {
    const view = deps.agent?.get(c.req.param("id"));
    const step = view?.steps[Number(c.req.param("n"))];
    if (!step?.screenshot) return c.json({ error: "not found" }, 404);
    return (
      serveUnder(deps.recordingsDir, resolve(step.screenshot)) ??
      c.json({ error: "not found" }, 404)
    );
  });
  /** A person's own explore command on a paused session; the reply is what the explore socket would say. */
  app.post("/api/agent/:id/exec", async (c) => {
    if (!deps.agent) return c.json({ error: "no model configured" }, 503);
    const parsed = commandSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: parsed.error.issues[0]?.message ?? "bad command" }, 400);
    try {
      return c.json({ result: await deps.agent.exec(c.req.param("id"), parsed.data) });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message.split("\n")[0] : String(err) },
        400,
      );
    }
  });
  app.post("/api/agent/:id/:action", async (c) => {
    const { id, action } = c.req.param();
    if (!deps.agent) return c.json({ error: "no model configured" }, 503);
    if (!(AGENT_ACTIONS as readonly string[]).includes(action))
      return c.json({ error: `unknown action ${action}` }, 400);
    const body = agentAction.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!body.success) return c.json({ error: "bad body" }, 400);
    try {
      switch (action as (typeof AGENT_ACTIONS)[number]) {
        case "pause":
          return c.json(await deps.agent.pause(id));
        case "resume":
          return c.json(await deps.agent.resume(id));
        case "stop":
          return c.json(await deps.agent.stop(id));
        case "close":
          return c.json(await deps.agent.close(id));
        case "save": {
          const name = body.data.name ?? deps.agent.get(id)?.goal.replace(/[^a-z0-9]+/gi, "-");
          if (!name || !NAME.test(name.toLowerCase()))
            return c.json({ error: "give a recording name: lowercase, dashes" }, 400);
          return c.json(await deps.agent.save(id, name.toLowerCase()));
        }
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  /** What a person typed on any channel (iMessage, Slack, a form). Replies with text for that channel. */
  app.post("/hooks/inbound", async (c) => {
    const body = inboundBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad body", issues: body.error.issues }, 400);
    const cmd = parseCommand(body.data.text, { workflows: [...byName.keys()] });
    if (!cmd)
      return c.json({
        reply: "say yes, no, pause, play, status or reset, optionally with <workflow> <key>",
      });
    const rows = await deps.ingress.registry().list();
    const target: RunRow | undefined = cmd.run
      ? rows.find((r) => r.workflow === cmd.run?.workflow && r.key === cmd.run?.key)
      : cmd.kind === "approve" || cmd.kind === "reject"
        ? rows.find((r) => r.status === "waiting")
        : rows[0];
    if (!target)
      return c.json({
        reply: cmd.run ? `no run ${cmd.run.workflow}/${cmd.run.key}` : "no run is waiting",
      });
    const run = runOf(target.workflow, target.key);
    const id = `${target.workflow}/${target.key}`;
    switch (cmd.kind) {
      case "approve":
      case "reject": {
        const gate = (await run.status()).gate;
        if (!gate) return c.json({ reply: `${id} is not waiting at a gate` });
        const args = { name: gate.name, ...(cmd.note ? { note: cmd.note } : {}) };
        await (cmd.kind === "approve" ? run.approve(args) : run.reject(args));
        return c.json({
          reply: `${id}: ${gate.name} ${cmd.kind === "approve" ? "approved" : "rejected"}`,
        });
      }
      case "status": {
        const s = await run.status();
        const line = s.gate
          ? `waiting at ${s.gate.step}: ${s.gate.prompt}`
          : s.outcome
            ? s.outcome.status
            : "running";
        return c.json({ reply: `${id}: ${line}${s.paused ? " (paused)" : ""}` });
      }
      default:
        await run[cmd.kind]();
        return c.json({ reply: `${id}: ${cmd.kind === "play" ? "playing" : cmd.kind}` });
    }
  });

  return app;
}
