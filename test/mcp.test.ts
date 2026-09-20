import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { Command, Explorer } from "../src/explore/server.js";
import { buildMcpServer } from "../src/mcp/server.js";

/** An explore session that answers from a script and logs every command. */
function fakeExplorer(): Explorer & { got: Command[] } {
  const got: Command[] = [];
  return {
    got,
    port: 0,
    token: "t",
    paused: () => false,
    resumed: async () => undefined,
    done: Promise.resolve(),
    async exec(c) {
      got.push(c);
      switch (c.cmd) {
        case "url":
          return { url: "https://x.test/" };
        case "aria":
          return { aria: '- button "Buy"' };
        case "click":
          if (c.hints.name === "Nope") throw new Error("locator.click: Timeout");
          return { url: "https://x.test/done" };
        case "os":
          return { tree: '- window "General"' };
        case "save":
          return { dir: `recordings/${c.name}`, actions: 2 };
        default:
          return { ok: true };
      }
    },
  };
}

async function connected() {
  const opened: string[] = [];
  const explorers = new Map<string, ReturnType<typeof fakeExplorer>>();
  const server = buildMcpServer({
    open: async (site, url) => {
      opened.push(`${site}:${url ?? ""}`);
      const ex = fakeExplorer();
      explorers.set(site, ex);
      return ex;
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return { client, server, opened, explorers };
}

const textOf = (r: unknown) =>
  JSON.parse(((r as { content: Array<{ text: string }> }).content[0]?.text ?? "null") as string);

describe("mcp server", () => {
  it("lists the tools Claude Code will see", async () => {
    const { client } = await connected();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "aria",
        "click",
        "close",
        "command",
        "fill",
        "open",
        "os",
        "save",
        "sessions",
        "start",
      ].sort(),
    );
  });

  it("opens one session per site and routes tools to it; a miss is an error result, not a crash", async () => {
    const { client, opened, explorers, server } = await connected();
    const started = await client.callTool({
      name: "start",
      arguments: { site: "scratch", url: "https://x.test/" },
    });
    expect(textOf(started)).toEqual({ site: "scratch", url: { url: "https://x.test/" } });
    await client.callTool({ name: "start", arguments: { site: "scratch" } });
    expect(opened).toEqual(["scratch:https://x.test/"]); // the second start reused it

    expect(textOf(await client.callTool({ name: "aria", arguments: { site: "scratch" } }))).toEqual(
      {
        aria: '- button "Buy"',
      },
    );
    const miss = await client.callTool({
      name: "click",
      arguments: { site: "scratch", hints: { role: "button", name: "Nope" } },
    });
    expect(miss.isError).toBe(true);
    await client.callTool({ name: "os", arguments: { site: "scratch", act: { op: "tree" } } });
    await client.callTool({
      name: "command",
      arguments: {
        site: "scratch",
        command: { cmd: "read", hints: { role: "cell" }, as: "price" },
      },
    });
    const noSession = await client.callTool({ name: "aria", arguments: { site: "other" } });
    expect(noSession.isError).toBe(true);
    expect((noSession.content as Array<{ text: string }>)[0]?.text).toMatch(/call start first/);

    await client.callTool({ name: "save", arguments: { site: "scratch", name: "buy-thing" } });
    await client.callTool({ name: "close", arguments: { site: "scratch" } });
    expect(server.sessions.size).toBe(0);
    expect(explorers.get("scratch")?.got.map((c) => c.cmd)).toEqual([
      "url",
      "url",
      "aria",
      "click",
      "os",
      "read",
      "save",
      "close",
    ]);
  });
});
