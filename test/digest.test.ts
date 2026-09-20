import { describe, expect, it } from "vitest";
import { digest, hintsFor } from "../src/agent/digest.js";

const TREE = `- banner:
  - link "Google Account":
    - img
  - generic:
    - button "Search"
- navigation "Primary":
  - link "Home"
  - link "Personal info"
  - link "Home"
- heading "Welcome, William" [level=1]
- text: Manage your info, privacy, and security
- text: Manage your info, privacy, and security
- paragraph: ${"x".repeat(200)}
- checkbox "Dark" [checked]
- 'button "Account: Jane (a@b.c), plan"':
  - /url: /x
- textbox "Say \\"hi\\""
- table:
  - row:
    - cell: one`;

describe("digest", () => {
  const d = digest(TREE);
  it("numbers only what can be acted on, keeps bearings, drops scaffolding and repeats", () => {
    expect(d.text).toBe(`[1] link "Google Account"
[2] button "Search"
[3] link "Home"
[4] link "Personal info"
[5] link "Home"
heading [level=1]: Welcome, William
  Manage your info, privacy, and security
  ${"x".repeat(99)}…
[6] checkbox "Dark" [checked]
[7] button "Account: Jane (a@b.c), plan"
[8] textbox "Say "hi""
  one`);
    expect(d.text).not.toMatch(/generic|img|banner/);
  });
  it("refs resolve to role + exact name, nth among twins", () => {
    expect(hintsFor(d.refs[2] as never)).toEqual({ role: "link", name: "Home" });
    expect(hintsFor(d.refs[4] as never)).toEqual({ role: "link", name: "Home", nth: 1 });
    expect(hintsFor(d.refs[7] as never)).toEqual({ role: "textbox", name: 'Say "hi"' });
  });
  it("caps the control list and says so", () => {
    const many = Array.from({ length: 90 }, (_, i) => `- button "b${i}"`).join("\n");
    const small = digest(many, { maxRefs: 10 });
    expect(small.refs).toHaveLength(10);
    expect(small.text).toContain("(+80 more controls below");
  });
});
