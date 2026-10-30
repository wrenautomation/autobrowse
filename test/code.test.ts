import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileCodeStores } from "../src/browser/attempt.js";
import { type CodeCall, CodeFailed, memoryStore, runCode } from "../src/browser/code.js";
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
    act: async (op: { kind: string }, h: { css?: string }) => {
      calls.push(`act ${op.kind} ${h.css}`);
      if (h.css === "boom" && !state.fixed) throw new Error("no boom");
      if (h.css?.startsWith("go:")) url = h.css.slice(3);
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
    const store = memoryStore();
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
    const keys: string[] = [];
    const store = { get: () => undefined, set: (k: string) => void keys.push(k) };
    await runCode(fp, { code: `await fp.read({css:"a"}); await fp.read({css:"a"});` }, { store });
    expect(keys.map((k) => k.split("#").at(-1))).toEqual(["0", "1"]);
  });

  it("a wait after an open waits only when the page loads", async () => {
    const { fp, calls } = fake();
    const store = memoryStore();
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

  it("an effect act runs once: a rerun skips it and goes on from its URL", async () => {
    const { fp, calls } = fake();
    const store = memoryStore();
    const code = `await fp.open("https://x.test/a"); await fp.act({kind:"click"}, {css:"go:https://x.test/b"}, {goal:"b"}); await fp.read({css:"t"});`;
    await runCode(fp, { code }, { store });
    await fp.open("https://x.test/");
    calls.length = 0;
    const trace: CodeCall[] = [];
    const r = await runCode(fp, { code }, { store, trace: (c) => trace.push(c) });
    expect(r.stored).toBe(2);
    expect(trace.find((c) => c.call === "act")).toMatchObject({
      stored: true,
      result: "done before",
    });
    // The read was keyed on /b, the URL the click went to; the run ends there.
    expect(calls).toEqual(["open https://x.test/b"]);
  });

  it("a rerun rebuilds the page: the URL, then the view acts after it", async () => {
    const { fp, calls, state } = fake();
    const store = memoryStore();
    const code = `await fp.open("https://x.test/list");
await fp.act({kind:"click"}, {css:"next"}, {goal:"next", view:true});
await fp.act({kind:"hover"}, {css:"row"}, {goal:"row"});
await fp.act({kind:"click"}, {css:"archive"}, {goal:"archive"});
await fp.read({css: plan.fixed ? "toast" : "x"});
if (!plan.fixed) throw new Error("fix me");`;
    await runCode(fp, { code }, { store }).catch(() => undefined);
    expect(calls).toEqual([
      "open https://x.test/list",
      "act click next",
      "act hover row",
      "act click archive",
      "read x",
    ]);
    state.fixed = true;
    calls.length = 0;
    await runCode(fp, { code, plan: { fixed: "1" } }, { store });
    // The archive is not done again; next and the hover are, to put the page back.
    expect(calls).toEqual([
      "open https://x.test/list",
      "act click next",
      "act hover row",
      "read toast",
    ]);
  });

  it("an act left started stops the run; ran skips it, redo does it again", async () => {
    const { fp, calls } = fake();
    const code = `await fp.act({kind:"click"}, {css:"pay"}, {goal:"pay"});`;
    const key = JSON.stringify(["act", { op: "click", hints: { css: "pay" } }, "https://x.test/"]);
    const store = memoryStore();
    store.set(`${key}#0`, { state: "started" });
    const err = await runCode(fp, { code }, { store }).catch((e) => e);
    expect((err as CodeFailed).result.failed).toMatchObject({ call: "act", error: /may have run/ });
    expect(calls).toEqual([]);
    await runCode(fp, { code }, { store, started: "ran" });
    expect(calls).toEqual([]);
    await runCode(fp, { code }, { store, started: "redo" });
    expect(calls).toEqual(["act click pay"]);
    await runCode(fp, { code }, { store });
    expect(calls).toHaveLength(1);
  });

  it("an act that threw runs again on the next run", async () => {
    const { fp, calls, state } = fake();
    const store = memoryStore();
    const code = `await fp.act({kind:"click"}, {css:"boom"}, {goal:"boom"});`;
    await runCode(fp, { code }, { store }).catch(() => undefined);
    state.fixed = true;
    await runCode(fp, { code }, { store });
    expect(calls).toEqual(["act click boom", "act click boom"]);
  });

  it("a stored-only run still ends on the page the code opened", async () => {
    const { fp, calls } = fake();
    const store = memoryStore();
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

  it("under a durable call the store is on disk: a retry in a new process skips the done act", async () => {
    const dir = mkdtempSync(join(tmpdir(), "code-calls-"));
    try {
      const { fp, calls } = fake();
      const code = `await fp.act({kind:"click"}, {css:"post"}, {goal:"post"});`;
      const on = (stores: ReturnType<typeof fileCodeStores>) =>
        ({ ...fp, codeStore: (scope: string) => stores("inv-1 step", scope) }) as FlowPage;
      await runCode(on(fileCodeStores(dir)), { code });
      await runCode(on(fileCodeStores(dir)), { code });
      expect(calls).toEqual(["act click post"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
