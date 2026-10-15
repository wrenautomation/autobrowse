import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAudit } from "credvault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Message } from "../src/auth/codes.js";
import { startExplore } from "../src/explore/server.js";
import { bankCodeReader } from "../src/money/bank-code.js";
import { parseCardLine } from "../src/money/wallet.js";

const FIELD = { role: "textbox", name: "Confirmation code" };

/**
 * A checkout whose bank challenge is four iframes down. The frames share the page's origin: the
 * explore browser in this build does not load a loopback frame of another origin (test/frames.test.ts
 * has the cross-origin chain, on plain Chromium).
 */
describe("the bank's code in a 3-D Secure iframe", () => {
  let dir: string;
  let web: Server;
  let webPort: number;
  let port: number;
  let done: Promise<void>;
  let token: string;
  let yesFile: string;
  const audit = memoryAudit();
  /** The paired phone's inbox. */
  const texts: Message[] = [];
  const text = (body: string, at: number): Message => ({
    from: "22000",
    subject: "",
    text: body,
    at: new Date(at),
  });
  /** Each text a minute after the last: a code handed out is spent, so the next must be newer. */
  let clock = Date.now();
  const later = () => (clock += 60_000);
  /** A `spend --grant` on the site, and which sites were asked about. */
  let granted = false;
  const grantAsks: string[] = [];
  /** Shifts the session's clock, to age the card. */
  let skew = 0;
  const visa = parseCardLine("4242424242424242 09/30 321", { label: "main", kind: "credit" });

  const send = async (cmd: Record<string, unknown>, wait = false) => {
    const r = await fetch(`http://127.0.0.1:${port}/${wait ? "?wait=1" : ""}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(cmd),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const codeIn = async () =>
    (await send({ cmd: "eval", hints: FIELD, js: "el => el.value" })).body.result;
  const codeUses = async () => (await audit.recent()).filter((u) => u.by.endsWith(".code"));
  const placeCode = (secret = "card.code") => send({ cmd: "place", hints: FIELD, secret });
  /** A fresh checkout, the card on it (the person says yes to the payment), the code field emptied. */
  const checkout = async () => {
    await send({ cmd: "open", url: `http://localhost:${webPort}/pay` });
    const card = await send(
      { cmd: "place", hints: { role: "textbox", name: "Card number" }, secret: "card.number" },
      true,
    );
    expect(card.body).toMatchObject({ ok: true });
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bank-code-"));
    yesFile = join(dir, "payment-flows.json");
    web = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      const frame = (path: string, title: string) =>
        `<iframe title="${title}" width="360" height="200" src="http://localhost:${webPort}${path}"></iframe>`;
      if (req.url === "/pay")
        res.end(
          `<h1>Checkout</h1><label>Card number <input id="n"></label><button>Pay now</button>${frame("/a", "3ds")}`,
        );
      else if (req.url === "/a") res.end(frame("/b", "acs"));
      else if (req.url === "/b") res.end(frame("/c", "bank"));
      else if (req.url === "/c") res.end(frame("/d", "challenge"));
      else res.end(`<label>Confirmation code <input id="otp"></label>`);
    }).listen(0);
    webPort = (web.address() as AddressInfo).port;
    port = 9700 + Math.floor(Math.random() * 200);
    ({ done, token } = await startExplore({
      site: "posthog",
      port,
      tokenFile: join(dir, "explore.token"),
      yesFile,
      idleMinutes: 0,
      now: () => Date.now() + skew,
      // The bank's frames are on no host the site owns: this would refuse any other secret there.
      secrets: async () => null,
      secretHosts: () => false,
      audit,
      cards: async () => ({ ...visa }),
      cardCode: bankCodeReader(
        { recent: async (_i, since) => texts.filter((m) => m.at >= since) },
        "+15555550182",
        { timeoutMs: 150, pollMs: 25 },
      ),
      grantedAhead: (site) => {
        grantAsks.push(site);
        return granted;
      },
      approve: async () => true,
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
    web.close();
    await new Promise((r) => setTimeout(r, 500));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("refuses before any card was placed: no payment is under way", async () => {
    await send({ cmd: "open", url: `http://localhost:${webPort}/pay` });
    texts.push(text("Your CIBC code is 909090", Date.now()));
    const r = await placeCode();
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/no card was placed/);
    expect(await codeIn()).toBe("");
    expect((await codeUses()).map((u) => u.allowed)).toEqual([false]);
  }, 30_000);

  it("fills into inputs four iframes down, with no frame named", async () => {
    await send({ cmd: "open", url: `http://localhost:${webPort}/pay` });
    await send({ cmd: "fill", hints: FIELD, value: "plain" });
    expect(await codeIn()).toBe("plain");
  }, 30_000);

  it("places the newest text received after the card, on any host or frame inside the grant", async () => {
    texts.length = 0;
    await checkout();
    const landed = Date.now();
    texts.push(
      text("Your CIBC code is 111111", landed - 60_000),
      text("CIBC verification code 222222. Do not share it.", landed + 1_000),
      text("CIBC code 333333 to confirm your purchase", landed + 2_000),
    );
    const r = await placeCode();
    expect(r.body).toMatchObject({ ok: true, secret: "card.code" });
    expect(await codeIn()).toBe("333333");
    // The frame is on no host the site owns (secretHosts refuses everything), yet the code landed.
    expect(JSON.stringify(await audit.recent())).not.toMatch(/333333|222222|111111/);
    expect((await codeUses()).map((u) => u.allowed)).toEqual([false, true]);
    // A resend is a new text; the one just typed is not handed out again.
    expect((await placeCode()).body.error).toMatch(/not available now/);
    texts.push(text("Your new CIBC code is 444444", later()));
    await placeCode("card@main.code");
    expect(await codeIn()).toBe("444444");
    expect((await placeCode("card@debit.code")).body.error).toMatch(/is main, not debit/);
  }, 60_000);

  it("refuses a card older than 10 minutes", async () => {
    await checkout();
    texts.push(text("Your CIBC code is 555555", later()));
    skew = 11 * 60_000;
    try {
      expect((await placeCode()).body.error).toMatch(/over 10 min ago/);
    } finally {
      skew = 0;
    }
    expect((await placeCode()).body).toMatchObject({ ok: true });
    expect(await codeIn()).toBe("555555");
  }, 60_000);

  it("refuses without a payment yes, and lets a spend grant stand for it", async () => {
    await checkout();
    texts.push(text("Your CIBC code is 666666", later()));
    // The person's yes lapses (or was never given): nothing is placed.
    await writeFile(yesFile, "{}");
    const refused = await placeCode();
    expect(refused.status).toBe(500);
    expect(refused.body.error).toMatch(/no payment yes for localhost is live/);
    expect(await codeIn()).not.toBe("666666");
    expect((await codeUses()).at(-1)?.allowed).toBe(false);
    // `spend --grant posthog` is that yes given ahead.
    granted = true;
    try {
      expect((await placeCode()).body).toMatchObject({ ok: true });
    } finally {
      granted = false;
    }
    expect(await codeIn()).toBe("666666");
    expect(grantAsks).toContain("posthog");
  }, 60_000);
});
