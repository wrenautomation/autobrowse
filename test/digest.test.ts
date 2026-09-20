import { describe, expect, it } from "vitest";
import { digest, hintsFor, pageForModel } from "../src/agent/digest.js";

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
  it("numbers what can be acted on or read, keeps bearings, drops scaffolding and repeats", () => {
    expect(d.text).toBe(`[1] link "Google Account"
[2] button "Search"
[3] link "Home"
[4] link "Personal info"
[5] link "Home"
[6] heading [level=1]: Welcome, William
  Manage your info, privacy, and security
  ${"x".repeat(99)}…
[7] checkbox "Dark" [checked]
[8] button "Account: Jane (a@b.c), plan"
[9] textbox "Say "hi""
[10] cell: one`);
    expect(d.text).not.toMatch(/generic|img|banner/);
  });
  it("refs resolve to role + exact name, nth among twins", () => {
    expect(hintsFor(d.refs[2] as never)).toEqual({ role: "link", name: "Home" });
    expect(hintsFor(d.refs[4] as never)).toEqual({ role: "link", name: "Home", nth: 1 });
    expect(hintsFor(d.refs[8] as never)).toEqual({ role: "textbox", name: 'Say "hi"' });
    expect(hintsFor(d.refs[5] as never)).toEqual({ role: "heading", name: "Welcome, William" });
    expect(hintsFor(d.refs[9] as never)).toEqual({ role: "cell", name: "one" });
  });
  it("caps the control list and says so", () => {
    const many = Array.from({ length: 90 }, (_, i) => `- button "b${i}"`).join("\n");
    const small = digest(many, { maxRefs: 10 });
    expect(small.refs).toHaveLength(10);
    expect(small.text).toContain("(+80 more controls below");
  });
});

describe("pageForModel", () => {
  const a = digest('- button "Save"\n- text: draft\n- textbox "Name"');
  it("sends the whole page first, one line when nothing changed, a delta when only text moved", () => {
    expect(pageForModel(null, a)).toBe(a.text);
    expect(pageForModel(a, a)).toMatch(/unchanged/);
    const b = digest('- button "Save"\n- text: saved\n- textbox "Name"');
    const d = pageForModel(a, b);
    expect(d).toMatch(/same controls/);
    expect(d).toContain("+ saved");
    expect(d).toContain("- draft");
  });
  it("sends the whole page when controls changed, since refs renumber", () => {
    const c = digest('- button "Cancel"\n- button "Save"\n- text: draft');
    expect(pageForModel(a, c)).toBe(c.text);
  });
});
