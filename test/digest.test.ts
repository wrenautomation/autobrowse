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
  it("outlines the page: containers kept where named, leaves joined, scaffolding and repeats dropped", () => {
    expect(d.text).toBe(`banner:
 [1]L Google Account · [2]B Search
navigation "Primary":
 [3]L Home · [4]L Personal info · [5]L Home
[6]H1 Welcome, William
Manage your info, privacy, and security
${"x".repeat(119)}…
[7]C Dark✓ · [8]B Account: Jane (a@b.c), plan · [9]T Say "hi" · one`);
    expect(d.text).not.toMatch(/generic|img|listitem/);
  });
  it("refs resolve to role + exact name, nth among twins", () => {
    expect(hintsFor(d.refs[2] as never)).toEqual({ role: "link", name: "Home" });
    expect(hintsFor(d.refs[4] as never)).toEqual({ role: "link", name: "Home", nth: 1 });
    expect(hintsFor(d.refs[8] as never)).toEqual({ role: "textbox", name: 'Say "hi"' });
    expect(hintsFor(d.refs[5] as never)).toEqual({ role: "heading", name: "Welcome, William" });
    expect(d.refs).toHaveLength(9);
  });
  it("rows and items read as one line; a row named after its contents keeps no header; cells are text", () => {
    const out = digest(`- table "Orders":
  - row "Date Item":
    - columnheader "Date"
    - columnheader "Item"
  - row "2026-09-20 Shoes":
    - cell "2026-09-20"
    - cell "Shoes":
      - link "Shoes"
- list:
  - listitem:
    - heading "First post" [level=3]
    - text: 3 likes
    - button "Reply"
  - listitem:
    - link "A nameless list"
- dialog "Sign in":
  - textbox "Email":
    - /placeholder: you@example.com
  - radio "Small" [checked]
  - text: Small
  - button "Next" [disabled]`);
    expect(out.text).toBe(`table "Orders":
 Date · Item
 2026-09-20 · [1]L Shoes
[2]H3 First post · 3 likes · [3]B Reply
[4]L A nameless list
dialog "Sign in":
 [5]T Email (you@example.com) · [6]R Small✓ · [7]B Next✗`);
  });
  it("folds a long run of look-alike rows to their leads, and caps the refs", () => {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `  - listitem:\n    - link "Post ${i}"\n    - text: ${i} likes`,
    ).join("\n");
    const out = digest(`- list "Feed":\n${rows}`, { maxRepeat: 3 });
    expect(out.text).toBe(`list "Feed":
 [1]L Post 0 · 0 likes
 [2]L Post 1 · 1 likes
 [3]L Post 2 · 2 likes
 (+9 more like these:)
 [4]L Post 3 · 3 likes · [5]L Post 4 · 4 likes · [6]L Post 5 · 5 likes · [7]L Post 6 · 6 likes · [8]L Post 7 · 7 likes
 [9]L Post 8 · 8 likes · [10]L Post 9 · 9 likes · [11]L Post 10 · 10 likes · [12]L Post 11 · 11 likes`);
    expect(out.refs).toHaveLength(12);
    const many = Array.from({ length: 90 }, (_, i) => `- button "b${i}"`).join("\n");
    const small = digest(many, { maxRefs: 10 });
    expect(small.refs).toHaveLength(10);
    expect(small.text).toContain("(+80 more controls below");
  });
  it("a control with no name is not offered; a nameless link takes its text", () => {
    const out = digest(`- button\n- link:\n  - text: Read more\n- link "x":\n  - img "icon"`);
    expect(out.text).toBe("[1]L Read more · [2]L x");
    expect(out.refs.map((r) => r.name)).toEqual(["", "x"]);
  });
});

describe("pageForModel", () => {
  const PAGE =
    '- heading "Editor" [level=1]\n- button "Save"\n- text: draft\n- textbox "Name"\n- heading "Footer" [level=2]';
  const a = digest(PAGE);
  it("sends the whole page first, one line when nothing changed, a delta when only text moved", () => {
    expect(pageForModel(null, a)).toBe(a.text);
    expect(pageForModel(a, a)).toMatch(/unchanged/);
    const b = digest(PAGE.replace("draft", "saved"));
    const d = pageForModel(a, b);
    expect(d).toMatch(/same controls/);
    expect(d).toContain("+ [2]B Save · saved · [3]T Name");
    expect(d).toContain("- [2]B Save · draft · [3]T Name");
    expect(d).not.toContain("Editor");
  });
  it("sends the whole page when controls changed, since refs renumber", () => {
    const c = digest(PAGE.replace('- button "Save"', '- button "Cancel"\n- button "Save"'));
    expect(pageForModel(a, c)).toBe(c.text);
  });
});
