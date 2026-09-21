import { describe, expect, it } from "vitest";

describe("kebab", () => {
  it("cuts a sentence-long note to a handle at a word boundary", async () => {
    const { kebab } = await import("../src/compiler/structure.js");
    expect(kebab("The goal is to open the Personal info page and report the display name")).toBe(
      "the-goal-is-to-open-the-personal-info",
    );
    expect(kebab("Open settings")).toBe("open-settings");
    expect(kebab("123 !!")).toBe("step");
  });
});

import { dropLookAround, looseName, structure } from "../src/compiler/structure.js";

describe("structure names", () => {
  it("names a step from a short note, and from the page when the note is a sentence", () => {
    const base = {
      site: "s",
      startedAt: "",
      finishedAt: "",
      trace: null,
      terminal: null,
      commands: [],
    };
    const target = {
      tag: "h1",
      role: "heading",
      name: "Example Domain",
      text: null,
      placeholder: null,
      id: null,
      testId: null,
      href: null,
      inputType: null,
    };
    const rec = {
      ...base,
      name: "r",
      actions: [
        { t: 0, kind: "navigate", url: "https://example.com/" },
        {
          t: 1,
          kind: "note",
          url: "https://example.com/",
          text: "The heading is right there; I will read it and report it.",
        },
        {
          t: 2,
          kind: "read",
          url: "https://example.com/",
          target,
          as: "title",
          value: "Example Domain",
        },
        { t: 3, kind: "navigate", url: "https://example.com/about" },
        { t: 4, kind: "note", url: "https://example.com/about", text: "Checkout" },
        {
          t: 5,
          kind: "click",
          url: "https://example.com/about",
          target: { ...target, role: "button", name: "Go" },
        },
      ],
    } as never;
    const o = structure(rec);
    expect(o.steps.map((s) => [s.name, s.description])).toEqual([
      ["example-com", "The heading is right there; I will read it and report it."],
      ["checkout", "Checkout"],
    ]);
  });
});

describe("structure fields", () => {
  const base = {
    site: "s",
    startedAt: "2026-09-22T00:00:00Z",
    finishedAt: "",
    trace: null,
    terminal: null,
    commands: [],
  };
  const input = (name: string, label = name) => ({
    tag: "input",
    role: "textbox",
    name: label,
    text: null,
    placeholder: null,
    id: null,
    testId: null,
    href: null,
    inputType: null,
    _n: name,
  });
  const at = (t: number, kind: string, target: unknown, extra: object) => ({
    t,
    kind,
    url: "https://example.com/",
    target,
    ...extra,
  });

  it("keys a placed secret by its name, and keeps field keys identifiers when they repeat", () => {
    const rec = {
      ...base,
      name: "r",
      actions: [
        { t: 0, kind: "navigate", url: "https://example.com/" },
        at(1, "input", input("Email"), { value: "•••", redacted: true, secret: "email" }),
        at(2, "input", input("Password"), { value: "•••", redacted: true, secret: "password" }),
        at(3, "input", input("Full name"), { value: "Wren", redacted: false }),
        at(4, "click", { ...input("Next"), tag: "button", role: "button" }, {}),
        at(5, "note", undefined, { text: "Second page" }),
        at(6, "input", input("Full name", "Full name"), {
          value: "Wren Automation",
          redacted: false,
        }),
      ],
    };
    // biome-ignore lint/suspicious/noExplicitAny: fixture
    const o = structure(rec as any);
    expect(o.secrets.map((s) => s.key)).toEqual(["email", "password"]);
    expect(o.fields.map((f) => f.key)).toEqual(["fullName", "fullName2"]);
  });

  it("a control clicked again right away is one click; an upload keeps its plan field", () => {
    const button = { ...input("Change photo"), tag: "button", role: "button" };
    const rec = {
      ...base,
      name: "r",
      actions: [
        { t: 0, kind: "navigate", url: "https://example.com/" },
        at(1, "click", button, {}),
        at(2, "click", button, {}),
        at(3, "upload", button, { files: ["/tmp/pfp.png"] }),
      ],
    };
    // biome-ignore lint/suspicious/noExplicitAny: fixture
    const o = structure(rec as any);
    expect(o.steps[0].ops.map((op) => op.kind)).toEqual(["click", "upload"]);
    expect(o.fields.map((f) => f.key)).toEqual(["changePhoto"]);
  });

  it("keeps only the last fill of a control within a step and prunes the fields it dropped", () => {
    const rec = {
      ...base,
      name: "r",
      actions: [
        { t: 0, kind: "navigate", url: "https://example.com/" },
        at(1, "input", input("Username"), { value: "wren", redacted: false }),
        at(2, "select", input("Month"), { value: "May" }),
        at(3, "input", input("Username"), { value: "wrenautomation", redacted: false }),
        at(4, "select", input("Month"), { value: "June" }),
      ],
    };
    // biome-ignore lint/suspicious/noExplicitAny: fixture
    const o = structure(rec as any);
    const ops = o.steps[0].ops;
    expect(ops.filter((op) => op.kind === "fill")).toHaveLength(1);
    expect(ops.filter((op) => op.kind === "select")).toHaveLength(1);
    expect(ops.find((op) => op.kind === "select")).toMatchObject({ value: "June" });
    expect(o.fields).toEqual([{ key: "username", label: "Username", example: "wrenautomation" }]);
  });
});

describe("looseName", () => {
  it("keeps the label before an address as a prefix match, and leaves other names alone", () => {
    expect(looseName("Contact info jin+wren@gmail.com")).toBe("/^Contact info/");
    expect(looseName("jin@gmail.com")).toBe("jin@gmail.com");
    expect(looseName("Change photo")).toBe("Change photo");
    expect(looseName("Add (new) a@b.co")).toBe("/^Add \\(new\\)/");
  });
});

describe("dropLookAround", () => {
  const click = (name: string, irreversible = false) => ({
    kind: "click" as const,
    goal: `click ${name}`,
    hints: { role: "button", name },
    irreversible,
  });
  const step = (name: string, description: string, ops: unknown[]) =>
    ({
      kind: "browser",
      name,
      description,
      irreversible: false,
      proof: null,
      url: null,
      ops,
    }) as never;
  it("drops trailing verifying clicks after the last change, and keeps a tail that does more", () => {
    const change = step("add-email", "Add the email", [
      {
        kind: "fill",
        goal: "fill",
        hints: { role: "textbox", name: "Email" },
        value: { from: "plan", field: "email" },
      },
      click("Next"),
    ]);
    const look = step("verify", "Let me verify the email shows now.", [
      click("Contact info"),
      click("Close"),
    ]);
    const again = step("check", "Check it once more to confirm.", [click("Contact info")]);
    expect(dropLookAround([change, look, again]).map((s) => s.name)).toEqual(["add-email"]);
    const more = step("remove", "Remove the old one.", [click("Remove", true)]);
    expect(dropLookAround([change, look, more]).map((s) => s.name)).toEqual([
      "add-email",
      "verify",
      "remove",
    ]);
    // Unsaid intent: a dismissal or a re-click is looking; a new control is not.
    const closes = step("after", "on /profile", [click("Close")]);
    expect(dropLookAround([change, closes]).map((s) => s.name)).toEqual(["add-email"]);
    const elsewhere = step("after", "on /profile", [click("Settings")]);
    expect(dropLookAround([change, elsewhere]).map((s) => s.name)).toEqual(["add-email", "after"]);
  });
});
