import { describe, expect, it } from "vitest";
import {
  type BitwardenRow,
  type BwRun,
  bitwardenItem,
  ITEM_PREFIX,
  syncBitwarden,
} from "../src/app/bitwarden.js";

const row = (key: string, password: string): BitwardenRow => ({
  key,
  url: `https://${key}.example/`,
  username: `${key}@example.com`,
  password,
  notes: "synthetic",
});

describe("Bitwarden sync", () => {
  it("keeps what matches, updates what changed, adds the rest; secrets never ride argv", async () => {
    const calls: { args: string[]; env?: Record<string, string>; input?: string }[] = [];
    const existing = [
      { id: "1", ...bitwardenItem(row("same", "p1")) },
      { id: "2", ...bitwardenItem(row("changed", "old")) },
      { id: "3", name: "someone else's item" },
    ];
    const run: BwRun = async (args, o = {}) => {
      calls.push({ args, ...o });
      if (args[0] === "unlock") return "session-key\n";
      if (args[0] === "list") return JSON.stringify(existing);
      return "";
    };
    const r = await syncBitwarden(
      [row("same", "p1"), row("changed", "new"), row("fresh", "p3")],
      "master",
      run,
    );
    expect(r).toEqual({ created: ["fresh"], updated: ["changed"], kept: ["same"] });

    expect(calls.map((c) => c.args[0])).toEqual([
      "unlock",
      "sync",
      "list",
      "edit",
      "create",
      "lock",
    ]);
    expect(calls[0]?.env).toEqual({ BW_PASSWORD: "master" });
    expect(calls.slice(1).every((c) => c.env?.BW_SESSION === "session-key")).toBe(true);
    const flat = calls.flatMap((c) => c.args).join(" ");
    for (const secret of ["master", "new", "p3", "session-key"]) expect(flat).not.toContain(secret);

    const edited = JSON.parse(Buffer.from(calls[3]?.input ?? "", "base64").toString());
    expect(calls[3]?.args).toEqual(["edit", "item", "2"]);
    expect(edited.login.password).toBe("new");
    expect(edited.name).toBe(`${ITEM_PREFIX}changed`);
  });

  it("locks even when a write fails", async () => {
    const seen: string[] = [];
    const run: BwRun = async (args) => {
      seen.push(args[0] ?? "");
      if (args[0] === "unlock") return "s";
      if (args[0] === "list") return "[]";
      if (args[0] === "create") throw new Error("bw create: refused");
      return "";
    };
    await expect(syncBitwarden([row("a", "p")], "m", run)).rejects.toThrow(/refused/);
    expect(seen.at(-1)).toBe("lock");
  });
});
