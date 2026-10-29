import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { overlayOn } from "../src/app/services-signin.js";
import { defineFlow, flowRunner } from "../src/browser/flow.js";

const PAGE = "<title>t</title><input aria-label=Card><button>Pay</button><p id=total>Total 12</p>";
const ui = "window[Object.keys(window).find((k) => k.startsWith('__data-o'))]";

describe("the overlay on a flow run", () => {
  const server = createServer((_q, r) =>
    r.writeHead(200, { "content-type": "text/html" }).end(PAGE),
  );
  const ready = new Promise<string>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}/pay?token=t`),
    ),
  );
  afterAll(() => server.close());
  const runnerWith = (overlay?: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-flow-overlay-"));
    return flowRunner(
      {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
      { pace: null, ...(overlay === undefined ? {} : { overlay }) },
    );
  };
  const pay = (seen: (trace: unknown) => void) =>
    defineFlow<string, void>({
      site: "scratch",
      name: "pay",
      async run(fp, url) {
        await fp.open(url);
        await fp.act(
          { kind: "fill", value: "4242424242424242" },
          { role: "textbox", name: "Card" },
          { goal: "type the card" },
        );
        await fp.read({ css: "#total" });
        await fp.act({ kind: "click" }, { role: "button", name: "Pay" }, { goal: "pay" });
        seen(await fp.page.evaluate(`${ui} ? ${ui}.s : null`));
      },
    });

  it("draws a row per step with its goal, never a typed value or a query", async () => {
    const url = await ready;
    let s: {
      goal: string;
      trace: Array<{ cmd: string; what: string; ok: boolean; note: string }>;
    } | null = null;
    await runnerWith(true).run(
      pay((t) => {
        s = t as typeof s;
      }),
      url,
    );
    expect(s).not.toBeNull();
    const got = s as unknown as NonNullable<typeof s>;
    expect(got.goal).toBe("scratch/pay");
    expect(got.trace.map((r) => [r.cmd, r.ok])).toEqual([
      ["open", true],
      ["fill", true],
      ["read", true],
      ["click", true],
    ]);
    expect(got.trace[1]?.what).toContain("type the card");
    expect(got.trace[2]?.note).toBe("8 chars read");
    expect(JSON.stringify(got)).not.toContain("4242");
    expect(JSON.stringify(got)).not.toContain("token");
  }, 60_000);

  it("is off unless asked", async () => {
    let s: unknown = "unset";
    await runnerWith().run(
      pay((t) => {
        s = t;
      }),
      await ready,
    );
    expect(s).toBeNull();
  }, 60_000);

  it("is on headed, off for a film or the desk, and a flag wins", () => {
    const at = (overlay: string, film?: string) => ({ overlay, film }) as never;
    expect(overlayOn(at("auto"), { headless: false })).toBe(true);
    expect(overlayOn(at("auto", "/f"), { headless: false })).toBe(false);
    expect(overlayOn(at("auto"), {})).toBe(false);
    expect(overlayOn(at("on"), {})).toBe(true);
    expect(overlayOn(at("auto", "/f"), { overlay: true })).toBe(true);
  });
});
