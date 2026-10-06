import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAudit } from "credvault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/compiler/index.js";
import { memorySink } from "../src/deps/sink.js";
import { fakeDesktop } from "../src/desktop/types.js";
import {
  journalFileFor,
  pageChange,
  readJournal,
  shortUrl,
  startExplore,
} from "../src/explore/server.js";
import type { Charge, Receipt } from "../src/money/charges.js";
import type { Contacts } from "../src/money/profile.js";
import { parseCardLine } from "../src/money/wallet.js";
import { loadRecording } from "../src/recorder/store.js";

const sink = memorySink();
const desktop = fakeDesktop([
  { role: "window", name: "General", value: null, enabled: true, depth: 0 },
  { role: "checkbox", name: "Remote Login", value: "0", enabled: true, depth: 1 },
  { role: "button", name: "Buy", value: null, enabled: true, depth: 1 },
]);

const PAGE = `data:text/html,${encodeURIComponent(
  `<label>Domain <input id="d"></label><label>Password <input type="password" id="p"></label><button id="go" onclick="document.title='clicked';this.after(Object.assign(document.createElement('p'),{textContent:'Payment successful'}))">Buy now</button><button id="co" onclick="document.title='checkout'">Checkout</button><input type="submit" id="done" value="Complete Order" onclick="event.preventDefault();document.title='ordered'"><p id="key">sk-ant-minted-key-1234567890abcdefghijklmnopqrstuvwxyz</p>`,
)}`;

describe("shortUrl", () => {
  it("keeps the path, drops a long query, leaves short URLs whole", () => {
    expect(shortUrl("https://a.test/x?y=1")).toBe("https://a.test/x?y=1");
    const oauth = `https://accounts.google.com/signin/oauth/v2/consentsummary?part=${"x".repeat(2000)}`;
    expect(shortUrl(oauth)).toBe("https://accounts.google.com/signin/oauth/v2/consentsummary?…");
    expect(shortUrl(`https://a.test/${"p".repeat(300)}`)).toHaveLength(151);
  });
});

describe("explore mode", () => {
  let dir: string;
  let port: number;
  let done: Promise<void>;
  let token: string;
  /** The person behind the payment gate: says yes, remembers what was asked. */
  const asks: string[] = [];
  let answer: boolean | null = true;
  /** Where placed secrets may land; the test page is a data: URL, so its host is "". */
  let allowHost = (_host: string) => true;
  const audit = memoryAudit();
  // Stripe's public test Visa, never a real card.
  const visa = parseCardLine("4242424242424242 09/30 321", { label: "main", kind: "credit" });
  const charges: Array<[Charge, Receipt, Contacts?]> = [];
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
    // Clear of the fixed 94xx loopback ports the oauth tests listen on.
    port = 9500 + Math.floor(Math.random() * 200);
    ({ done, token } = await startExplore({
      site: "scratch",
      port,
      desktop,
      sink,
      tokenFile: join(dir, "explore.token"),
      yesFile: join(dir, "payment-flows.json"),
      secrets: async (name) => (name === "minted" ? "Placed-Value-77" : null),
      secretHosts: (host) => allowHost(host),
      audit,
      cards: async ({ label }) => {
        if (label && label !== "main") throw new Error(`no card "${label}" in the wallet`);
        return { ...visa, tell: { email: "card-owner@x.co" } };
      },
      charges: async (c, r, tell) => {
        charges.push([c, r, tell]);
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
    // Beside it, who serves the port (`autobrowse browsers`): idle-closes, so not held.
    const info = JSON.parse(await readFile(join(dir, "explore.json"), "utf8"));
    expect(info).toMatchObject({ port, pid: process.pid, site: "scratch", held: false });
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
    // An act answers the URL short; `url` answers it whole.
    expect(opened.body, JSON.stringify(opened.body)).toHaveProperty("url", shortUrl(PAGE));
    expect((await send({ cmd: "url" })).body).toEqual({ url: PAGE });
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
    expect(placed.body).toMatchObject({ ok: true, secret: "minted" });
    expect(
      (await send({ cmd: "eval", js: "document.querySelector('#d').value" })).body.result,
    ).toBe("Placed-Value-77");
    const unknown = await send({ cmd: "place", hints: { css: "#d" }, secret: "nope" });
    expect(unknown.status).toBe(500);
    expect(unknown.body.error).toMatch(/nope is not available now/);
    expect(unknown.body.error).toMatch(/no flag gives "nope"/);
    // A page off the bound hosts never gets the value; the refusal is in the ledger, the value is not.
    allowHost = () => false;
    await send({ cmd: "fill", hints: { css: "#d" }, value: "" });
    const leak = await send({ cmd: "place", hints: { css: "#d" }, secret: "minted" });
    expect(leak.status).toBe(500);
    expect(leak.body.error).toMatch(/scratch's minted is not typed on .*SIGNUP_ALSO_HOSTS/);
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
    // Silence is not a no: it says so, and the next send asks again.
    answer = null;
    expect((await send(buy)).status).toBe(202);
    const silent = await send(buy);
    expect(silent.status).toBe(403);
    expect(silent.body).toMatchObject({ gate: "payment", reason: "no-answer" });
    answer = true;
    // `?wait=1` holds the request until the answer: one request, the act done on a yes.
    expect((await send(buy, true)).status).toBe(200);
    expect((await send({ cmd: "eval", js: "document.title" })).body.result).toBe("clicked");
    expect(asks).toHaveLength(3); // once per answer (the no, the silence, then the yes); the missing "Purchase" asked nobody
    expect(asks[1]).toMatch(/^start paying on .*: press "Buy now", which spends \(one yes covers/);
    // The yes-and-click is a charge: told with the page it landed on as the receipt.
    expect(charges).toHaveLength(1);
    expect(charges[0]?.[0]).toMatchObject({
      site: "scratch",
      what: 'press "Buy now", which spends',
      card: "the card the site keeps (ending not known here)",
      outcome: "charged", // the page says paid; an unclear page is told nothing
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
    expect(asks).toHaveLength(3);
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
    // The site prefilled its login email where the receipt goes.
    await send({
      cmd: "eval",
      js: `document.body.insertAdjacentHTML("beforeend", '<label>Email <input type="email" id="em" value="login@site.co"></label>')`,
    });
    answer = true;
    // A card field: one yes per card and host, then each field lands; the value never crosses the socket.
    const number = await send(
      { cmd: "place", hints: { role: "textbox", name: "Domain" }, secret: "card.number" },
      true,
    );
    expect(number.body).toMatchObject({ ok: true, secret: "card.number", billing: ["email"] });
    expect((await send({ cmd: "eval", js: "em.value" })).body.result).toBe("card-owner@x.co");
    expect(asks.at(-1)).toMatch(/^start paying on .*: put main: Visa credit ••4242 on /);
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
    // Its charge is told to the card's own contacts, and the flow's yes covers the pay click.
    const asked = asks.length;
    await send({ cmd: "click", hints: { role: "button", name: "Buy now" } }, true);
    expect(asks).toHaveLength(asked);
    expect(charges.at(-1)?.[0].card).toMatch(/Visa credit ending 4242/);
    expect(charges.at(-1)?.[2]).toEqual({ email: "card-owner@x.co" });
  });
  it("an act answers what changed on the page; a batch runs in order and stops at the first failure", async () => {
    const grow = `data:text/html,${encodeURIComponent(
      `<input id="q" placeholder="Name"><button onclick="this.after(Object.assign(document.createElement('button'),{textContent:'Confirm '+q.value}))">Add</button>`,
    )}`;
    const opened = await send({ cmd: "open", url: grow });
    expect((opened.body.changed as { added: string[] }).added.join("\n")).toMatch(/text=Add/);
    const one = await send({ cmd: "click", hints: { role: "button", name: "Add" } });
    expect(one.body.changed).toEqual({ added: ["button text=Confirm"], gone: 0 });

    const both = await send({
      cmd: "batch",
      cmds: [
        { cmd: "fill", hints: { placeholder: "Name" }, value: "Ada" },
        { cmd: "click", hints: { role: "button", name: "Add" } },
        { cmd: "click", hints: { role: "button", name: "Nowhere" } },
        { cmd: "click", hints: { role: "button", name: "Add" } },
      ],
    });
    expect(both.status).toBe(200);
    expect(both.body.done).toHaveLength(2);
    expect(both.body.failed).toMatchObject({ at: 2, cmd: "click" });
    expect(both.body.changed).toEqual({ added: ["button text=Confirm Ada"], gone: 0 });

    const bad = await send({ cmd: "batch", cmds: [{ cmd: "url" }, { cmd: "close" }] });
    expect(bad.body.error).toMatch(/batch\[1\]: close cannot be batched/);
  }, 60_000);

  it("reads a list as rows with the driver's code and journals the op a walk replays", async () => {
    const list = `data:text/html,${encodeURIComponent(
      "<ul><li><b>Acme</b> <a href='https://acme.test/'>site</a></li><li><b>Globex</b></li></ul>",
    )}`;
    await send({ cmd: "open", url: list });
    const records = {
      cmd: "records",
      as: "firms",
      goal: "firms on the list",
      fields: [
        { key: "name", says: "the firm" },
        { key: "site", says: "its link", optional: true },
      ],
    };
    const code = `return [...root.querySelectorAll("li")].map((li) => ({
      name: li.querySelector("b").textContent, site: li.querySelector("a")?.href }));`;
    const got = await send({ ...records, code });
    expect(got.body).toMatchObject({ as: "firms", rows: 2, min: 1 });
    expect(got.body.first).toContain('"site":"https://acme.test/"');
    const { actions } = (await send({ cmd: "journal", last: 1 })).body as {
      actions: Array<{ kind: string; op?: { kind: string; key: string; code: string } }>;
    };
    expect(actions[0]).toMatchObject({
      kind: "records",
      op: { kind: "records", key: "name", code },
    });
    // No code and no model: refused, nothing journaled.
    expect((await send(records)).body.error).toMatch(/send `code`/);
    expect((await send({ cmd: "records", ...records, code: "return [];" })).body.error).toMatch(
      /no rows/,
    );
  }, 60_000);
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

describe("a session that dies", () => {
  it("leaves its journal; the next one resumes it on the last page; close drops it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explore-resume-"));
    const journalFile = journalFileFor(join(dir, "recordings"), "scratch", "test");
    const start = (idleMinutes = 0) =>
      startExplore({
        site: "scratch",
        port: 9700 + Math.floor(Math.random() * 90),
        recordingsDir: join(dir, "recordings"),
        journalFile,
        idleMinutes,
        tokenFile: join(dir, "explore.token"),
        browser: {
          tier: "local",
          channel: "chromium",
          profilesDir: join(dir, "profiles"),
          artifactsDir: join(dir, "artifacts"),
          headless: true,
        },
      });
    try {
      const first = await start(0.005); // dies idle after 300 ms: not a close
      expect(first.resumedFrom).toBeNull();
      await first.exec({ cmd: "open", url: PAGE });
      await first.exec({ cmd: "note", text: "on the form" });
      await first.done;
      const left = readJournal(journalFile);
      expect(left.length).toBeGreaterThanOrEqual(2);
      const second = await start();
      expect(second.resumedFrom).toEqual({ acts: left.length, url: left.at(-1)?.url });
      // Never idle-closes: held, and `browsers` says so.
      const info = JSON.parse(await readFile(join(dir, "explore.json"), "utf8"));
      expect(info.held).toBe(true);
      await second.exec({ cmd: "note", text: "after the crash" });
      const j = (await second.exec({ cmd: "journal" })) as { total: number };
      expect(j.total).toBe(left.length + 1);
      // `browsers stop` closes and keeps the journal; a plain close drops it.
      await second.exec({ cmd: "close", keep: true });
      await second.done;
      expect(existsSync(join(dir, "explore.json"))).toBe(false);
      expect(readJournal(journalFile)).toHaveLength(left.length + 1);
      const third = await start();
      await third.exec({ cmd: "close" });
      await third.done;
      expect(readJournal(journalFile)).toEqual([]);
    } finally {
      await new Promise((r) => setTimeout(r, 500));
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);
});

describe("pageChange", () => {
  it("diffs rows as a multiset and caps what it returns", () => {
    expect(pageChange(["a", "b", "b"], ["b", "c", "c"])).toEqual({ added: ["c", "c"], gone: 2 });
    const many = Array.from({ length: 45 }, (_, i) => `r${i}`);
    expect(pageChange([], many)).toMatchObject({ gone: 0, more: 5 });
  });
});

describe("help without a pause", () => {
  it("a person's acts between two commands are journaled and the next answer says so, once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explore-help-"));
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
      // The agent's own act is never help.
      const own = (await ex.exec({
        cmd: "fill",
        hints: { role: "textbox", name: "Domain" },
        value: "x.com",
      })) as object;
      expect(own).not.toHaveProperty("helped");
      // A person types a code and clicks on, after the agent's command has ended.
      await ex.exec({
        cmd: "eval",
        js: `setTimeout(() => { const i = document.querySelector('#d'); i.focus(); i.value = '123456'; i.dispatchEvent(new Event('input', {bubbles: true})); i.dispatchEvent(new Event('change', {bubbles: true})); const b = document.querySelector('#co'); b.textContent = 'Verified'; b.click(); }, 1200)`,
      });
      await new Promise((r) => setTimeout(r, 2000));
      const next = (await ex.exec({ cmd: "count", hints: { role: "button" } })) as {
        helped?: { acts: number; note: string; changed?: { added: string[] } };
        count: number;
      };
      expect(next.count).toBeGreaterThan(0);
      expect(next.helped?.acts).toBeGreaterThanOrEqual(1);
      expect(next.helped?.note).toMatch(/do not redo/);
      expect(next.helped?.changed?.added.join(" ")).toContain("Verified");
      const again = (await ex.exec({ cmd: "count", hints: { role: "button" } })) as object;
      expect(again).not.toHaveProperty("helped");
      const journal = (await ex.exec({ cmd: "journal" })) as {
        actions: Array<{ kind: string; text?: string }>;
      };
      const kinds = journal.actions.map((a) => a.kind);
      expect(kinds).toContain("input");
      expect(journal.actions.some((a) => a.kind === "note" && /by hand/.test(a.text ?? ""))).toBe(
        true,
      );
    } finally {
      await ex.exec({ cmd: "close" }).catch(() => undefined);
      await ex.done;
      await new Promise((r) => setTimeout(r, 500));
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);
});

describe("a session that cannot open", () => {
  it("fails the start with the reason, never hangs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explore-fail-"));
    await expect(
      startExplore({
        site: "scratch",
        port: 9950 + Math.floor(Math.random() * 40),
        recordingsDir: join(dir, "recordings"),
        browser: {
          tier: "browserbase",
          channel: "chromium",
          profilesDir: join(dir, "profiles"),
          artifactsDir: join(dir, "artifacts"),
          headless: true,
        },
      }),
    ).rejects.toThrow(/needs BROWSERBASE_API_KEY/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("network and html", () => {
  it("lists the page's calls redacted, shows one, saves and diffs pages, and diffs against the last session", async () => {
    const { createServer } = await import("node:http");
    let version = 1;
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/api/ads")) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            version === 1
              ? { ads: [{ advertiser: "Acme" }], session: "s3cr3t" }
              : { ads: [{ advertiser: "Acme", url: "https://acme.test" }] },
          ),
        );
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        `<ul><li>ad ${version}</li></ul><script>fetch("/api/ads?q=roof&token=abc").then(r=>r.json())</script>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const dir = await mkdtemp(join(tmpdir(), "explore-net-"));
    const session = () =>
      startExplore({
        site: "scratch",
        port: 9600 + Math.floor(Math.random() * 150),
        recordingsDir: join(dir, "recordings"),
        browser: {
          tier: "local",
          channel: "chromium",
          profilesDir: join(dir, "profiles"),
          artifactsDir: join(dir, "artifacts"),
          headless: true,
        },
      });
    type Calls = { calls: string[]; file: string };
    const callsOf = async (ex: Awaited<ReturnType<typeof session>>) => {
      await expect
        .poll(async () => ((await ex.exec({ cmd: "network" })) as Calls).calls.length)
        .toBe(2);
      return (await ex.exec({ cmd: "network" })) as Calls;
    };
    try {
      const one = await session();
      await one.exec({ cmd: "open", url });
      const listed = await callsOf(one);
      expect(listed.calls[0]).toMatch(/^\d+ GET 200 127\.0\.0\.1:\d+ \(page\)/);
      expect(listed.calls[1]).toMatch(/GET 200 127\.0\.0\.1:\d+\/api\/ads .*\{ads,session\}$/);
      const id = Number(listed.calls[1]?.split(" ")[0]);
      const call = (await one.exec({ cmd: "network", id })) as { url: string; body: string };
      expect(call.url).toContain("token=%3Credacted%3E");
      expect(call.body).toContain('"<redacted>"');
      expect(call.body).not.toContain("s3cr3t");
      const first = (await one.exec({ cmd: "html", diff: true })) as {
        file: string;
        reason: string;
      };
      expect(first.reason).toBe("no earlier save of this page");
      expect(await readFile(first.file, "utf8")).toContain("<script></script>");
      version = 2;
      await one.exec({ cmd: "open", url });
      const second = (await one.exec({ cmd: "html", diff: true })) as {
        diff: { added: string[]; removed: string[] };
      };
      expect(second.diff).toMatchObject({ added: ["<li>ad 2</li>"], removed: ["<li>ad 1</li>"] });
      await one.exec({ cmd: "close" });
      await one.done;
      expect(existsSync(listed.file)).toBe(true);

      const two = await session();
      await two.exec({ cmd: "open", url });
      await callsOf(two);
      const d = (await two.exec({ cmd: "network", diff: true })) as {
        diff: { added: string[]; gone: string[]; changed: { added: string[]; gone: string[] }[] };
      };
      expect(d.diff.added).toEqual([]);
      expect(d.diff.gone).toEqual([]);
      expect(d.diff.changed).toEqual([
        // Session one saw both versions; this one only the second.
        expect.objectContaining({ added: [], gone: ["session"] }),
      ]);
      await two.exec({ cmd: "close" });
      await two.done;
    } finally {
      server.close();
      await new Promise((r) => setTimeout(r, 500));
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 90_000);
});
