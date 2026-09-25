import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  inputLines,
  inputsOf,
  inputsOfJson,
  jsonSchemaOf,
  templateOf,
} from "../src/engine/inputs.js";

const plan = z.object({
  provider: z.literal("cloudflare").describe("Whose credentials"),
  tokenName: z.string().min(1).default("autobrowse"),
  permissions: z
    .array(z.object({ scope: z.string(), level: z.enum(["Read", "Edit"]) }))
    .default([{ scope: "Zone", level: "Edit" }]),
  status: z.object({ privacy: z.string().default("private"), at: z.string().optional() }),
  note: z.string().optional(),
  dryRun: z.boolean().default(false),
});

describe("inputs", () => {
  it("one row per field: nested objects dotted, a list's rows under it, dryRun left to the CLI", () => {
    expect(inputsOf(plan)).toEqual([
      { name: "provider", type: '"cloudflare"', required: true, about: "Whose credentials" },
      { name: "tokenName", type: "string", required: false, default: "autobrowse" },
      {
        name: "permissions",
        type: "{scope, level}[]",
        required: false,
        default: [{ scope: "Zone", level: "Edit" }],
      },
      { name: "permissions[].scope", type: "string", required: true },
      { name: "permissions[].level", type: '"Read"|"Edit"', required: true },
      { name: "status.privacy", type: "string", required: false, default: "private" },
      { name: "status.at", type: "string", required: false },
      { name: "note", type: "string", required: false },
    ]);
  });

  it("reads the same rows from JSON Schema that crossed a wire", () => {
    expect(inputsOfJson(JSON.parse(JSON.stringify(jsonSchemaOf(plan))))).toEqual(inputsOf(plan));
  });

  it("a template fills defaults, blanks what is required, leaves out optional fields", () => {
    expect(templateOf(plan)).toEqual({
      provider: "cloudflare",
      tokenName: "autobrowse",
      permissions: [{ scope: "Zone", level: "Edit" }],
      status: { privacy: "private" },
    });
    // A blank required string fails the plan loudly instead of running with junk.
    expect(plan.safeParse({ ...templateOf(plan), tokenName: "" }).success).toBe(false);
  });

  it("prints aligned lines; a long default is summarized", () => {
    const lines = inputLines(inputsOf(plan));
    expect(lines[2]).toMatch(/^ {2}permissions +\{scope, level\}\[\] +default \[1 item\]$/);
    expect(lines[5]?.indexOf("default")).toBe(lines[2]?.indexOf("default"));
    expect(inputLines([])).toEqual(["  (no inputs)"]);
  });
});
