import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAudit } from "credvault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/compiler/index.js";
import { memorySink } from "../src/deps/sink.js";
import { fakeDesktop } from "../src/desktop/types.js";
import { startExplore } from "../src/explore/server.js";
import type { Charge, Receipt } from "../src/money/charges.js";
import { parseCardLine } from "../src/money/wallet.js";
import { loadRecording } from "../src/recorder/store.js";

const sink = memorySink();
const desktop = fakeDesktop([
  { role: "window", name: "General", value: null, enabled: true, depth: 0 },
  { role: "checkbox", name: "Remote Login", value: "0", enabled: true, depth: 1 },
  { role: "button", name: "Buy", value: null, enabled: true, depth: 1 },
]);

const PAGE = `data:text/html,${encodeURIComponent(
  `<label>Domain <input id="d"></label><label>Password <input type="password" id="p"></label><button id="go" onclick="document.title='clicked'">Buy now</button><button id="co" onclick="document.title='checkout'">Checkout</button><input type="submit" id="done" value="Complete Order" onclick="event.preventDefault();document.title='ordered'"><p id="key">sk-ant-minted-key-1234567890abcdefghijklmnopqrstuvwxyz</p>`,
)}`;

describe("explore mode", () => {
  let dir: string;
  let port: number;
  let done: Promise<void>;
  let token: string;
  /** The person behind the payment gate: says yes, remembers what was asked. */
  const asks: string[] = [];
  let answer = true;
  /** Where placed secrets may land; the test page is a data: URL, so its host is "". */
  let allowHost = (_host: string) => true;
  const audit = memoryAudit();
  // Stripe's public test Visa, never a real card.
  const visa = parseCardLine("4242424242424242 09/30 321", { label: "main", kind: "credit" });
  const charges: Array<[Charge, Receipt]> = [];
  const send = async (cmd: Record<string, unknown>, wait = false) => {
    const r = await fetch(`http://127.0.0.1:${port}/${wait ? "?wait=1" : ""}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(cmd),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "explore-"));
    port = 9300 + Math.floor(Math.random() * 500);
    ({ done, token } = await startExplore({
      site: "scratch",
      port,
      desktop,
      sink,
      tokenFile: join(dir, "explore.token"),
      secrets: async (name) => (name === "minted" ? "Placed-Value-77" : null),
      secretHosts: (host) => allowHost(host),
      audit,
      cards: async ({ label }) => {
        if (label && label !== "main") throw new Error(`no card "${label}" in the wallet`);
        return visa;
      },
      charges: async (c, r) => {
        charges.push([c, r]);
        return ["email", "text"];
      },
      approve: async (ask) => {
        asks.push(ask.what);
        return answer;
      },
      recordingsDir: join(dir, "recordings"),
      browser: {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
    }));
  }, 30_000);
  afterAll(async () => {
    await send({ cmd: "close" }).catch(() => undefined);
    await done;
    expect(existsSync(join(dir, "explore.token"))).toBe(false); // gone with the session
    await new Promise((r) => setTimeout(r, 500)); // Chrome still flushes its profile
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("leaves the bearer token in an owner-only file for the session's life", async () => {
    const file = join(dir, "explore.token");
    expect(await readFile(file, "utf8")).toBe(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("runs page commands one after another, however they arrive", async () => {
    await send({ cmd: "open", url: PAGE });
    const slow = send({
      cmd: "eval",
      js: "new Promise(r => setTimeout(() => { window.__order = 'slow'; r('slow') }, 400))",
    });
    const fast = send({ cmd: "eval", js: "window.__order" });
    const [a, b] = await Promise.all([slow, fast]);
    expect(a.body.result).toBe("slow");
    expect(b.body.result).toBe("slow"); // the second waited for the first
    // Session controls do not queue: a pause lands even behind a slow act.
    const busy = send({ cmd: "eval", js: "new Promise(r => setTimeout(r, 600))" });
    const t0 = Date.now();
    await send({ cmd: "url" });
    expect(Date.now() - t0).toBeLessThan(400);
    await busy;
  });

  it("takes commands one at a time, journals the ones that work, and saves a compilable recording", async () => {
    const opened = await send({ cmd: "open", url: PAGE });
    expect(opened.body, JSON.stringify(opened.body)).toHaveProperty("url", PAGE);
    const aria = (await send({ cmd: "aria" })).body.aria as string;
    expect(aria).toContain('button "Buy now"');
    expect(aria).toContain('textbox "Domain"');

    const miss = await send({ cmd: "click", hints: { role: "button", name: "Purchase" } });
    expect(miss.status).toBe(500);
    expect(miss.body.error).toMatch(/timeout|Timeout/);

    await send({ cmd: "fill", hints: { role: "textbox", name: "Domain" }, value: "x.com" });
    await send({
      cmd: "fill",
      hints: { role: "textbox", name: "Password" },
      value: "hunter2hunter2",
    });
    // A secret by name: the page gets the value, the socket and the journal never do.
    const placed = await send({
      cmd: "place",
      hints: { role: "textbox", name: "Domain" },
      secret: "minted",
    });
    expect(placed.body).toEqual({ ok: true, secret: "minted" });
    expect(
      (await send({ cmd: "eval", js: "document.querySelector('#d').value" })).body.result,
    ).toBe("Placed-Value-77");
    const unknown = await send({ cmd: "place", hints: { css: "#d" }, secret: "nope" });
    expect(unknown.status).toBe(500);
    expect(unknown.body.error).toMatch(/nope is not available now/);
    // A page off the bound hosts never gets the value; the refusal is in the ledger, the value is not.
    allowHost = () => false;
    await send({ cmd: "fill", hints: { css: "#d" }, value: "" });
    const leak = await send({ cmd: "place", hints: { css: "#d" }, secret: "minted" });
    expect(leak.status).toBe(500);
    expect(leak.body.error).toMatch(/scratch \(minted\)'s password is not typed on/);
    expect(
      (await send({ cmd: "eval", js: "document.querySelector('#d').value" })).body.result,
    ).toBe("");
    allowHost = () => true;
    const uses = await audit.recent();
    expect(uses.map((u) => [u.by, u.allowed])).toEqual([
      ["place minted", true],
      ["place minted", false],
    ]);
    expect(JSON.stringify(uses)).not.toContain("Placed-Value-77");
    // "Buy now" spends: over the socket the person is asked once (202) and the same
    // command comes back after the reply; a no leaves the page untouched.
    const buy = { cmd: "click", hints: { role: "button", name: "Buy now" } };
    answer = false;
    const asked = await send(buy);
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ gate: "payment", reason: "asked" });
    const refused = await send(buy);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ gate: "payment", reason: "denied" });
    expect((await send({ cmd: "eval", js: "document.title" })).body.result).not.toBe("clicked");
    answer = true;
    // `?wait=1` holds the request until the answer: one request, the act done on a yes.
    expect((await send(buy, true)).status).toBe(200);
    expect((await send({ cmd: "eval", js: "document.title" })).body.result).toBe("clicked");
    expect(asks).toHaveLength(2); // once per answer (the no, then the yes); the missing "Purchase" asked nobody
    expect(asks[1]).toMatch(/^start paying on .*: press "Buy now", which spends \(one yes covers/);
    // The yes-and-click is a charge: told with the page it landed on as the receipt.
    expect(charges).toHaveLength(1);
    expect(charges[0]?.[0]).toMatchObject({
      site: "scratch",
      what: 'press "Buy now", which spends',
      card: "the card the site keeps (ending not known here)",
      outcome: "unclear", // the test page says neither paid nor declined
    });
    expect(charges[0]?.[1].text).toContain("Buy now");
    expect(charges[0]?.[1].text).not.toContain("sk-ant-minted"); // masked like any transcript
    expect(charges[0]?.[1].png?.length).toBeGreaterThan(100);
    // A css-only click is judged by the button's own words: "Checkout" is no charge, "Complete
    // Order" (an input's value) is one; the yes above covers both (one yes per payment flow).
    expect((await send({ cmd: "click", hints: { css: "#co" } }, true)).status).toBe(200);
    expect(charges).toHaveLength(1);
    expect((await send({ cmd: "click", hints: { css: "#done" } }, true)).status).toBe(200);
    expect((await send({ cmd: "eval", js: "document.title" })).body.result).toBe("ordered");
    expect(asks).toHaveLength(2);
    expect(charges).toHaveLength(2);

    // A popup (an OAuth window) is listed and switched to; closing it returns to the main page.
    await send({ cmd: "eval", js: 'window.open("about:blank", "pop")' });
    await new Promise((r) => setTimeout(r, 500));
    const pages = (await send({ cmd: "pages" })).body.pages as Array<{ index: number }>;
    expect(pages).toHaveLength(2);
    expect((await send({ cmd: "page", index: 1 })).body).toHaveProperty("url", "about:blank");
    expect((await send({ cmd: "pages" })).body.pages).toMatchObject([
      { active: false },
      { active: true },
    ]);
    await send({ cmd: "eval", js: "window.close()" });
    await new Promise((r) => setTimeout(r, 300));
    expect((await send({ cmd: "pages" })).body.pages).toMatchObject([{ active: true }]);
    expect((await send({ cmd: "page", index: 5 })).status).toBe(500);

    const bad = await send({ cmd: "nope" });
    expect(bad.status).toBe(400);
    const noToken = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" });
    expect(noToken.status).toBe(401);
    // nth picks among matches; css is the explicit last resort
    expect((await send({ cmd: "count", hints: { role: "textbox" } })).body.count).toBe(2);
    expect(
      (await send({ cmd: "eval", js: "document.querySelector('#p').value" })).body.result,
    ).toBe("hunter2hunter2");

    // A minted secret goes to the sink; the journal and the socket never carry it.
    const kept = await send({ cmd: "keep", hints: { css: "#key" }, env: "TEST_MINTED_KEY" });
    expect(kept.body).toEqual({ env: "TEST_MINTED_KEY", length: 54 });
    expect(sink.values.TEST_MINTED_KEY).toMatch(/^sk-ant-minted-key-/);

    // Desktop acts share the session and the journal; looking is not journaled, typed secrets are hidden.
    const tree = (await send({ cmd: "os", act: { op: "tree" } })).body.tree as string;
    expect(tree).toContain('- checkbox "Remote Login": 0');
    expect(
      (await send({ cmd: "os", act: { op: "click", role: "checkbox", name: "Remote Login" } }))
        .body,
    ).toEqual({ ok: true });
    expect((await send({ cmd: "os", act: { op: "click", name: "Nope" } })).status).toBe(500);
    await send({ cmd: "os", act: { op: "type", text: "hunter2hunter2", secret: true } });
    await send({ cmd: "os", act: { op: "shell", command: "true" } });
    expect(desktop.acts.map((a) => a.op)).toEqual(["click", "type", "shell"]);
    // A desktop "Buy" is gated like the page's: asked, refused on a no, done on a yes.
    const osBuy = { cmd: "os", act: { op: "click", role: "button", name: "Buy" } };
    answer = false;
    expect((await send(osBuy)).body).toMatchObject({ gate: "payment", reason: "asked" });
    expect((await send(osBuy)).status).toBe(403);
    expect(desktop.acts.length).toBe(3);
    answer = true;
    expect((await send(osBuy, true)).status).toBe(200);
    expect(desktop.acts.at(-1)).toMatchObject({ op: "click", name: "Buy" });
    expect(asks.at(-1)).toMatch(
      /^start paying on app:\w+: press "Buy", which spends in \w+ \(one yes/,
    );

    const saved = await send({ cmd: "save", name: "buy" });
    expect(saved.body.actions).toBe(14); // the ordering test's open is journaled too
    const rec = await loadRecording(join(dir, "recordings"), "buy");
    // (the page's own data: URL holds the fixture; the acts must not)
    expect(JSON.stringify(rec.actions.map(({ url: _u, ...a }) => a))).not.toContain(
      "sk-ant-minted",
    );
    expect(rec.actions.map((a) => a.kind)).toEqual([
      "navigate",
      "navigate",
      "input",
      "input",
      "input",
      "input",
      "click",
      "click",
      "click",
      "keep",
      "desktop",
      "desktop",
      "desktop",
      "desktop",
    ]);
    const typed = rec.actions[11];
    expect(
      typed.kind === "desktop" && typed.redacted && typed.op.op === "type" && typed.op.text,
    ).toBe("<redacted>");
    const pw = rec.actions[3];
    expect(pw.kind === "input" && pw.value).toBe("<redacted>");
    const placedAct = rec.actions[4];
    expect(placedAct.kind === "input" && placedAct.redacted && placedAct.value).toBe("<redacted>");
    expect(JSON.stringify(rec.actions)).not.toContain("Placed-Value");
    const compiled = await compile(rec);
    expect(compiled.outline.steps.length).toBeGreaterThan(0);
  }, 60_000);

  it("puts a card on a page after one yes per card and host", async () => {
    // (a new flow: the first test's yes covers PAGE itself)
    await send({ cmd: "open", url: `${PAGE}#card` });
    answer = true;
    // A card field: one yes per card and host, then each field lands; the value never crosses the socket.
    const number = await send(
      { cmd: "place", hints: { role: "textbox", name: "Domain" }, secret: "card.number" },
      true,
    );
    expect(number.body).toEqual({ ok: true, secret: "card.number" });
    expect(asks.at(-1)).toMatch(/^start paying on .*: put main: Visa credit ••4242 exp 09\/30 on /);
    await send({ cmd: "place", hints: { css: "#p" }, secret: "card@main.cvc" }, true);
    expect(asks.filter((a) => a.includes("put main"))).toHaveLength(1);
    expect((await send({ cmd: "eval", js: "[d.value, p.value].join(' ')" })).body.result).toBe(
      "4242424242424242 321",
    );
    const other = await send({ cmd: "place", hints: { css: "#p" }, secret: "card@debit.cvc" });
    expect(other.body.error).toMatch(/no card "debit"/);
    const cardUses = (await audit.recent()).filter((u) => u.by.startsWith("place card"));
    expect(cardUses.map((u) => u.allowed)).toEqual([true, true, false]);
    expect(JSON.stringify(cardUses)).not.toContain("4242424242424242");
  });
});

describe("pause: a person's hand acts land in the journal", () => {
  it("journals clicks and typing between pause and resume, nothing outside", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explore-pause-"));
    const port = 9800 + Math.floor(Math.random() * 150);
    const ex = await startExplore({
      site: "scratch",
      port,
      recordingsDir: join(dir, "recordings"),
      browser: {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
    });
    try {
      await ex.exec({ cmd: "open", url: PAGE });
      // Nobody to ask: a spending click is refused, not guessed.
      await expect(
        ex.exec({ cmd: "click", hints: { role: "button", name: "Buy now" } }),
      ).rejects.toThrow(/needs a person.*no channel/);
      await ex.exec({ cmd: "pause" });
      expect(ex.paused()).toBe(true);
      // A person "clicks" and "types": real DOM events, as a hand would raise them.
      await ex.exec({
        cmd: "eval",
        js: `document.querySelector('input').focus(); document.querySelector('input').value='x.com'; document.querySelector('input').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('input').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('button').click();`,
      });
      await new Promise((r) => setTimeout(r, 300));
      const resumed = (await ex.exec({ cmd: "resume" })) as { handActs: number };
      expect(resumed.handActs).toBeGreaterThanOrEqual(1);
      const journal = (await ex.exec({ cmd: "journal" })) as { actions: Array<{ kind: string }> };
      const kinds = journal.actions.map((a) => a.kind);
      const p = kinds.indexOf("pause");
      const r = kinds.indexOf("resume");
      expect(p).toBeGreaterThan(-1);
      expect(kinds.slice(p + 1, r)).toContain("click");
      const tail = (await ex.exec({ cmd: "journal", last: 1 })) as {
        total: number;
        actions: unknown[];
      };
      expect(tail).toMatchObject({ total: kinds.length, actions: [expect.anything()] });
    } finally {
      await ex.exec({ cmd: "close" }).catch(() => undefined);
      await ex.done;
      await new Promise((r) => setTimeout(r, 500));
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);
});

describe("a session nobody closes", () => {
  it("closes itself after its idle time, browser and all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explore-idle-"));
    const ex = await startExplore({
      site: "scratch",
      port: 9950 + Math.floor(Math.random() * 40),
      recordingsDir: join(dir, "recordings"),
      idleMinutes: 0.005, // 300 ms
      browser: {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
    });
    try {
      const closed = await Promise.race([
        ex.done.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
      ]);
      expect(closed).toBe(true);
    } finally {
      await ex.exec({ cmd: "close" }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 30_000);
});
