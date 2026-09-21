/**
 * autobrowse as tools for Claude Code (or any MCP client) over stdio: the
 * explore session's commands, one site at a time. Claude Code drives the
 * browser and the desktop through the same journaled session a person or
 * the built-in agent uses, so what it does compiles to a workflow the same
 * way. The socket's own redaction applies: nothing leaves masked less than
 * over loopback.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { desktopOpSchema } from "../desktop/types.js";
import type { DoOutcome, DoRequest } from "../do/doer.js";
import { type Command, commandSchema, type Explorer } from "../explore/server.js";

export interface McpDeps {
  /** Open a journaled session on a site (the site's stored login applies). */
  open(site: string, url: string | null): Promise<Explorer>;
  /** The one verb; absent when the CLI has no backend to route through. */
  do?: (req: DoRequest) => Promise<DoOutcome>;
  version?: string;
}

const site = z
  .string()
  .regex(/^[a-z][a-z0-9@.-]*$/)
  .describe("site profile, e.g. google, cloudflare, scratch");

/** Every result as one text block: JSON the way the loopback socket answers. */
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});

export function buildMcpServer(deps: McpDeps): McpServer & { sessions: Map<string, Explorer> } {
  const server = new McpServer({ name: "autobrowse", version: deps.version ?? "0.0.0" });
  const sessions = new Map<string, Explorer>();
  const get = (s: string): Explorer => {
    const ex = sessions.get(s);
    if (!ex) throw new Error(`no open session on ${s}: call start first`);
    return ex;
  };
  const run = async (s: string, c: Command) => {
    try {
      const out = await get(s).exec(c);
      if (c.cmd === "close") sessions.delete(s);
      return text(out);
    } catch (err) {
      return fail(err);
    }
  };

  server.registerTool(
    "start",
    {
      description:
        "Open a browser session on a site profile (signed in with stored credentials when the site has them). One session per site; every act is journaled and `save` turns the journal into a recording to compile.",
      inputSchema: { site, url: z.string().url().optional() },
    },
    async ({ site: s, url }) => {
      try {
        if (!sessions.has(s)) sessions.set(s, await deps.open(s, url ?? null));
        else if (url) await get(s).exec({ cmd: "open", url });
        return text({ site: s, url: await get(s).exec({ cmd: "url" }) });
      } catch (err) {
        return fail(err);
      }
    },
  );
  if (deps.do) {
    const verb = deps.do;
    server.registerTool(
      "do",
      {
        description:
          'One verb over everything autobrowse can do: "upload this to youtube", "list my linkedin posts". Routes to a site API, a compiled workflow or a flow and runs it; with nothing ready, the agent explores and the result is compiled for next time. dryRun says what would run.',
        inputSchema: {
          goal: z.string().min(1),
          inputs: z.record(z.string(), z.string()).optional(),
          site: z.string().optional(),
          url: z.string().url().optional(),
          dryRun: z.boolean().optional(),
        },
      },
      async ({ goal, inputs, site: s, url, dryRun }) => {
        try {
          return text(
            await verb({
              goal,
              inputs: inputs ?? {},
              site: s ?? null,
              url: url ?? null,
              dryRun: dryRun ?? false,
            }),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );
  }
  server.registerTool("sessions", { description: "Sites with an open session." }, async () =>
    text({ sites: [...sessions.keys()] }),
  );
  server.registerTool(
    "aria",
    {
      description:
        "The page's accessibility tree: every control by role and name, headings and text. Read it before acting; hints for click/fill come from it.",
      inputSchema: { site, limit: z.number().int().positive().optional() },
    },
    ({ site: s, limit }) => run(s, { cmd: "aria", ...(limit ? { limit } : {}) }),
  );
  server.registerTool(
    "open",
    {
      description: "Navigate the session to a URL (a login wall is signed through).",
      inputSchema: { site, url: z.string().url() },
    },
    ({ site: s, url }) => run(s, { cmd: "open", url }),
  );
  const hints = z
    .object({
      role: z.string().optional(),
      name: z.string().optional(),
      text: z.string().optional(),
      placeholder: z.string().optional(),
      css: z.string().optional(),
      nth: z.number().int().nonnegative().optional(),
    })
    .describe("locator hints from the aria tree; role+name first, css last");
  server.registerTool(
    "click",
    {
      description: "Click a control found by hints.",
      inputSchema: { site, hints, goal: z.string().optional() },
    },
    ({ site: s, hints: h, goal }) => run(s, { cmd: "click", hints: h, ...(goal ? { goal } : {}) }),
  );
  server.registerTool(
    "fill",
    {
      description:
        "Type into a field found by hints. Password fields and token-shaped values are redacted in the journal.",
      inputSchema: { site, hints, value: z.string(), goal: z.string().optional() },
    },
    ({ site: s, hints: h, value, goal }) =>
      run(s, { cmd: "fill", hints: h, value, ...(goal ? { goal } : {}) }),
  );
  server.registerTool(
    "os",
    {
      description:
        "An act on the desktop outside the browser: apps, tree (the front app's controls), click by role+name, type (secret:true for passwords), key ('cmd+q', 'return'), shot, shell (root:true through the audited helper).",
      inputSchema: { site, act: desktopOpSchema },
    },
    ({ site: s, act }) => run(s, { cmd: "os", act }),
  );
  server.registerTool(
    "command",
    {
      description:
        "Any explore command as JSON, for what the other tools do not cover: select, press, upload, key, type, text, url, screenshot, eval {js}, count, read {hints, as}, note {text}, pause, resume, journal, pages, page {index}.",
      inputSchema: { site, command: commandSchema },
    },
    ({ site: s, command }) => run(s, command),
  );
  server.registerTool(
    "save",
    {
      description:
        "Write the session's journal as a recording (lowercase-dashes name); `autobrowse compile <name>` makes it a workflow.",
      inputSchema: { site, name: z.string().regex(/^[a-z][a-z0-9-]*$/) },
    },
    ({ site: s, name }) => run(s, { cmd: "save", name }),
  );
  server.registerTool(
    "close",
    { description: "Close the site's session and its browser.", inputSchema: { site } },
    ({ site: s }) => run(s, { cmd: "close" }),
  );
  return Object.assign(server, { sessions });
}
