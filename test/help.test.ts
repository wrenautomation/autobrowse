import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { firstClause, tidyHelp } from "../src/app/help.js";

describe("help", () => {
  it("a subcommand's line stops at its first clause, never inside brackets or code", () => {
    expect(firstClause('Store a credential from stdin JSON: {"username"}')).toBe(
      "Store a credential from stdin JSON",
    );
    expect(firstClause("Credentials into this file (reads fill it; e.g. offline); kept")).toBe(
      "Credentials into this file (reads fill it; e.g. offline)",
    );
    expect(firstClause("Run `a: b` here. Then more")).toBe("Run `a: b` here");
    expect(firstClause("No clause at all")).toBe("No clause at all");
  });
  it("groups top-level commands in order, short lines, no [options]", () => {
    const p = new Command("autobrowse");
    p.command("doctor").description("What answers now: search keys and more");
    p.command("zzz <thing>").option("--x").description("Not grouped: kept whole");
    p.command("run <workflow> <key>").option("--plan <p>").description("Start a run: long text");
    tidyHelp(p);
    const help = p.helpInformation();
    expect(help.indexOf("Do things:")).toBeLessThan(help.indexOf("This machine:"));
    expect(help).toContain("run <workflow> <key>");
    expect(help).not.toContain("[options] <workflow>");
    expect(help).toMatch(/More:\n {2}zzz <thing> +Not grouped: kept whole/);
  });
});
