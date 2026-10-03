import { memoryCredentials } from "credvault";
import { describe, expect, it } from "vitest";
import {
  dropRole,
  giveRole,
  type Held,
  keyFor,
  namedStore,
  resolveAccount,
  rolesTaken,
} from "../src/auth/roles.js";

const held: Held[] = [
  { key: "x", username: "me@gmail.com", roles: ["main", "personal"] },
  { key: "x@wren", username: "wren_automation", roles: ["wren"] },
  { key: "reddit@alt", username: "alt@a.com", roles: ["alt"] },
  { key: "reddit@wren", username: "WrenAutomation", roles: ["wren"] },
  { key: "github", username: "WilliamJin123", roles: [] },
];

describe("account names", () => {
  it("reaches one account by its role, its key or its username", () => {
    expect(resolveAccount(held, "x")).toBe("x");
    expect(resolveAccount(held, "x@personal")).toBe("x");
    expect(resolveAccount(held, "x@me@gmail.com")).toBe("x");
    expect(resolveAccount(held, "x@wren")).toBe("x@wren");
    expect(resolveAccount(held, "x@Wren_Automation")).toBe("x@wren");
    expect(resolveAccount(held, "reddit@wrenautomation")).toBe("reddit@wren");
  });

  it("a bare site is its main account, else its only one, else none", () => {
    expect(resolveAccount(held, "github")).toBe("github");
    expect(resolveAccount(held, "reddit")).toBeNull();
    expect(resolveAccount(held, "github@nobody")).toBeNull();
    expect(resolveAccount(held, "slack")).toBeNull();
  });

  it("a key's label is a claimed role: no role can name a second account", () => {
    expect(rolesTaken(held, "reddit@wren", ["alt"])).toEqual([
      { role: "alt", username: "alt@a.com" },
    ]);
    expect(rolesTaken(held, "x@wren", ["main"])).toEqual([
      { role: "main", username: "me@gmail.com" },
    ]);
    expect(rolesTaken(held, "x@wren", ["brand"])).toEqual([]);
  });

  it("new keys are the form SSM reads back", () => {
    expect(keyFor("Reddit@Ok_Crow")).toBe("reddit@ok-crow");
  });

  it("the store answers every name, makes new keys, and keeps one account per role", async () => {
    const inner = memoryCredentials({
      x: { username: "me@gmail.com", password: "p", roles: ["main"] },
      "x@wren": { username: "wren_automation", password: "q", roles: ["wren"] },
    });
    const s = namedStore(inner);
    expect((await s.get("x@wren_automation"))?.password).toBe("q");
    expect(await s.keyOf("x@main")).toBe("x");
    await s.put("x@wren_automation", {
      username: "wren_automation",
      password: "r",
      roles: ["wren"],
    });
    expect((await inner.get("x@wren"))?.password).toBe("r");
    await s.put("x@wren", { username: "wren_automation", password: "s" });
    expect((await inner.get("x@wren"))?.roles).toEqual(["wren"]);
    await s.put("x@New_One", { username: "New_One", password: "n" });
    expect(await inner.list()).toContain("x@new-one");
    await expect(
      s.put("x@new_one", { username: "New_One", password: "n", roles: ["wren"] }),
    ).rejects.toThrow(/x@wren is wren_automation/);
    expect(await s.remove?.("x@new_one")).toBe(true);
    expect(await inner.list()).not.toContain("x@new-one");
  });

  it("moving a role takes it off the other account; one named by it moves to its username", async () => {
    const inner = memoryCredentials({
      "reddit@alt": { username: "alt@a.com", password: "a" },
      "reddit@wren": { username: "WrenAutomation", password: "w", roles: ["brand"] },
      "reddit@new": { username: "Ok_Crow", password: "n" },
    });
    const move = await giveRole(inner, "reddit@new", "alt");
    expect(move.renamed).toEqual([{ from: "reddit@alt", to: "reddit@alt@a.com" }]);
    expect((await inner.get("reddit@alt@a.com"))?.password).toBe("a");
    expect(await inner.get("reddit@alt")).toBeNull();
    expect(await namedStore(inner).keyOf("reddit@alt")).toBe("reddit@new");
    expect((await giveRole(inner, "reddit@new", "brand")).took).toEqual(["WrenAutomation"]);
    expect((await inner.get("reddit@wren"))?.roles).toEqual([]);
    expect(await dropRole(inner, "reddit", "brand")).toBe("Ok_Crow");
    await expect(dropRole(inner, "reddit", "wren")).rejects.toThrow(/by its key/);
    await expect(giveRole(inner, "reddit@new", "Bad Role")).rejects.toThrow(/not a role/);
  });
});
