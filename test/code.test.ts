import { describe, expect, it } from "vitest";
import { type CodeCall, CodeFailed, runCode } from "../src/browser/code.js";
import type { FlowPage } from "../src/browser/flow.js";
import { NeedsHuman } from "../src/browser/session.js";

/** A fake page: `read` answers `<url>:<css>`; page 3 throws until `fixed`. */
const fake = () => {
  const calls: string[] = [];
  let url = "https://x.test/";
  const state = { fixed: false };
  const fp = {
    url: () => url,
    open: async (u: string) => {
      calls.push(`open ${u}`);
      url = u;
    },
    read: async (h: { css: string }) => {
      calls.push(`read ${h.css}`);
      if (url.endsWith("/3") && !state.fixed) throw new Error("no #title on page 3");
      return `${url}:${h.css}`;
    },
    has: async () => {
      calls.push("has");
      return true;
    },
    act: async (op: { kind: string }) => {
      calls.push(`act ${op.kind}`);
    },
    wait: async () => undefined,
    human: (r: string) => {
      throw new NeedsHuman(r);
    },
  } as unknown as FlowPage;
  return { fp, calls, state };
};

const LOOP = `
for (let p = 1; p <= 3; p++) {
  log({ page: p });
  await fp.open("https://x.test/" + p);
  rows.push({ p, title: await fp.read({ css: "#title" }) });
}`;

describe("runCode", () => {
  it("fails at page 3 with its log; the rerun takes 1-2 from the store and goes on", async () => {
    const { fp, calls, state } = fake();
    const store = new Map<string, { value: unknown }>();
    const err = await runCode(fp, { code: LOOP }, { store }).catch((e) => e);
    expect(err).toBeInstanceOf(CodeFailed);
    expect((err as CodeFailed).result.failed).toMatchObject({
      call: "read",
      url: "https://x.test/3",
      log: { page: 3 },
      error: "no #title on page 3",
    });
    expect((err as CodeFailed).result.rows).toHaveLength(2);

    state.fixed = true;
    await fp.open("https://x.test/");
    calls.length = 0;
    const trace: CodeCall[] = [];
    const r = await runCode(fp, { code: LOOP }, { store, trace: (c) => trace.push(c) });
    expect(r.rows).toHaveLength(3);
    expect(r.stored).toBe(2);
    // Pages 1-2: no page work. Page 3: the lazy open, then the read.
    expect(calls).toEqual(["open https://x.test/3", "read #title"]);
    // A log rides the first call after it.
    expect(trace.filter((c) => c.call === "open").map((c) => c.log)).toEqual([
      { page: 1 },
      { page: 2 },
      { page: 3 },
    ]);
    expect(trace.filter((c) => c.call === "read").map((c) => c.stored)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("n keeps two same-URL reads apart", async () => {
    const { fp } = fake();
    const store = new Map<string, { value: unknown }>();
    await runCode(fp, { code: `await fp.read({css:"a"}); await fp.read({css:"a"});` }, { store });
    expect([...store.keys()].map((k) => k.split("#").at(-1))).toEqual(["0", "1"]);
  });

  it("a wait after an open waits only when the page loads", async () => {
    const { fp, calls } = fake();
    const store = new Map<string, { value: unknown }>();
    const code = `await fp.open("https://x.test/w"); await fp.wait(500); await fp.read({css:"t"});`;
    await runCode(fp, { code }, { store });
    await fp.open("https://x.test/");
    calls.length = 0;
    const r = await runCode(fp, { code }, { store });
    expect(r.stored).toBe(1);
    expect(calls).toEqual(["open https://x.test/w"]);
  });

  it("an open of the page it is on still loads it fresh", async () => {
    const { fp, calls } = fake();
    await runCode(fp, { code: `await fp.open("https://x.test/"); await fp.has({css:"a"});` });
    expect(calls).toEqual(["open https://x.test/", "has"]);
  });

  it("acts always run live, after the lazy open", async () => {
    const { fp, calls } = fake();
    const store = new Map<string, { value: unknown }>();
    const code = `await fp.open("https://x.test/a"); await fp.act({kind:"click"}, {css:"b"}, {goal:"b"});`;
    await runCode(fp, { code }, { store });
    await fp.open("https://x.test/");
    calls.length = 0;
    await runCode(fp, { code }, { store });
    expect(calls).toEqual(["open https://x.test/a", "act click"]);
  });

  it("a stored-only run still ends on the page the code opened", async () => {
    const { fp, calls } = fake();
    const store = new Map<string, { value: unknown }>();
    const code = `await fp.open("https://x.test/z"); await fp.read({css:"t"});`;
    await runCode(fp, { code }, { store });
    await fp.open("https://x.test/");
    calls.length = 0;
    await runCode(fp, { code }, { store });
    expect(calls).toEqual(["open https://x.test/z"]);
  });

  it("the code's own error has no call; a person's need passes through", async () => {
    const { fp } = fake();
    const err = await runCode(fp, { code: `null.x` }).catch((e) => e);
    expect((err as CodeFailed).result.failed).toMatchObject({ call: null, error: /null/ });
    await expect(runCode(fp, { code: `fp.human("captcha")` })).rejects.toBeInstanceOf(NeedsHuman);
  });

  it("plan is a read-only copy; a call cap stops a loop that never ends", async () => {
    const { fp } = fake();
    const r = await runCode(fp, { code: `rows.push(plan.q)`, plan: { q: "dune" } });
    expect(r.rows).toEqual(["dune"]);
    const err = await runCode(
      fp,
      { code: `while (true) await fp.has({css:"a"})` },
      { maxCalls: 5 },
    ).catch((e) => e);
    expect((err as CodeFailed).result.failed.error).toMatch(/more than 5 calls/);
  });

  it("code can't build code from strings", async () => {
    const { fp } = fake();
    const err = await runCode(fp, { code: `eval("1")` }).catch((e) => e);
    expect(err).toBeInstanceOf(CodeFailed);
  });
});
