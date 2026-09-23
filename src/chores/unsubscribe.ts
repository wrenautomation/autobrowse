/**
 * Unsubscribe from the mailing lists an inbox got onto (registries, tools,
 * trials): find every recent sender that offers `List-Unsubscribe`, show the
 * list, and only on a yes leave each one by the cheapest honest path —
 * RFC 8058 one-click POST, else a mailto, else the link in a browser. Mail
 * without that header (receipts, codes, people) is never touched: a list
 * is something that says how to leave it.
 */

import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import { defineFlow } from "../browser/flow.js";
import type { HttpClient } from "../clients/http.js";

/** The Gmail routes this reads through (`sites.call("gmail", …)`). */
export interface Mailbox {
  call(method: "GET" | "POST", path: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface Subscription {
  /** The sender's address, lower case: the key. */
  sender: string;
  name: string;
  domain: string;
  count: number;
  latest: { id: string; subject: string; date: string };
  /** RFC 8058: POST this URL with `List-Unsubscribe=One-Click`. */
  oneClick?: string;
  /** An https link a person (or the browser leg) opens. */
  link?: string;
  /** A mailto the inbox sends to. */
  mailto?: { to: string; subject: string };
}

interface Header {
  name: string;
  value: string;
}
interface Message {
  id: string;
  payload?: { headers?: Header[] };
}

const header = (m: Message, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** `"Acme" <news@acme.com>` → name + address; a bare address is its own name. */
export function parseFrom(from: string): { name: string; address: string } {
  const m = /^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/.exec(from);
  const address = (m?.[2] ?? from).trim().toLowerCase();
  const name = (m?.[1] ?? "").trim() || address;
  return { name, address };
}

/** The `<…>` entries of a List-Unsubscribe header, split by scheme. */
export function parseListUnsubscribe(value: string): { https: string[]; mailto: string[] } {
  const https: string[] = [];
  const mailto: string[] = [];
  for (const m of value.matchAll(/<([^>]+)>/g)) {
    const u = (m[1] ?? "").trim();
    if (/^https:\/\//i.test(u)) https.push(u);
    else if (/^mailto:/i.test(u)) mailto.push(u);
  }
  return { https, mailto };
}

const mailtoOf = (u: string): { to: string; subject: string } => {
  const [addr, query = ""] = u.slice("mailto:".length).split("?");
  const subject = new URLSearchParams(query).get("subject") ?? "unsubscribe";
  return { to: decodeURIComponent(addr ?? ""), subject };
};

/** Gmail answers a burst with 403/429 (per-user rate): wait and try again. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function patient<T>(f: () => Promise<T>, pauseMs = 2000): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (i >= 6 || (status !== 403 && status !== 429)) throw e;
      await sleep(pauseMs * 2 ** i);
    }
  }
}

/**
 * One row per sender that offers a way out, most mail first. `days` bounds
 * the search (none = all time); `keep` are sender domains never listed (the
 * fleet's own). One fetch at a time, `gapMs` apart, each patient with the
 * rate limit (Gmail refuses bursts well under its published quota).
 */
export async function findSubscriptions(
  mailbox: Mailbox,
  o: {
    days?: number;
    keep?: readonly string[];
    maxMessages?: number;
    pauseMs?: number;
    gapMs?: number;
  } = {},
): Promise<Subscription[]> {
  const gapMs = o.gapMs ?? 100;
  const keep = new Set((o.keep ?? []).map((d) => d.toLowerCase()));
  const max = o.maxMessages ?? 5000;
  const q = o.days ? `newer_than:${o.days}d unsubscribe` : "unsubscribe";
  const call = (path: string, input: Record<string, unknown>) =>
    patient(() => mailbox.call("GET", path, input), o.pauseMs);
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = (await call("/gmail/v1/users/me/messages", {
      q,
      maxResults: Math.min(500, max - ids.length),
      ...(pageToken ? { pageToken } : {}),
    })) as { messages?: { id: string }[]; nextPageToken?: string };
    for (const m of page.messages ?? []) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);

  const messages: Message[] = [];
  for (const id of ids) {
    messages.push(
      (await call(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, {
        format: "metadata",
      })) as Message,
    );
    if (gapMs) await sleep(gapMs);
  }
  const bySender = new Map<string, Subscription>();
  for (const m of messages) {
    const lu = header(m, "List-Unsubscribe");
    if (!lu) continue;
    const { name, address } = parseFrom(header(m, "From"));
    const domain = address.split("@")[1] ?? "";
    if (!address || keep.has(domain)) continue;
    const { https, mailto } = parseListUnsubscribe(lu);
    const oneClick = /one-click/i.test(header(m, "List-Unsubscribe-Post")) ? https[0] : undefined;
    const date = header(m, "Date");
    const row = bySender.get(address);
    if (row) {
      row.count += 1;
      if (new Date(date).getTime() > new Date(row.latest.date).getTime())
        row.latest = { id: m.id, subject: header(m, "Subject"), date };
      continue;
    }
    bySender.set(address, {
      sender: address,
      name,
      domain,
      count: 1,
      latest: { id: m.id, subject: header(m, "Subject"), date },
      ...(oneClick ? { oneClick } : {}),
      ...(https[0] ? { link: https[0] } : {}),
      ...(mailto[0] ? { mailto: mailtoOf(mailto[0]) } : {}),
    });
  }
  return [...bySender.values()].sort(
    (a, b) => b.count - a.count || a.sender.localeCompare(b.sender),
  );
}

/** RFC 2822 for the mailto path, base64url as Gmail's send takes it. */
export function rawMail(from: string, to: string, subject: string): string {
  const text = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "unsubscribe",
  ].join("\r\n");
  return Buffer.from(text, "utf8").toString("base64url");
}

/** The browser leg: open the link; press the one button that confirms, if the page has one. */
export const unsubscribeLink: BrowserFlow<{ url: string }, { text: string; pressed: boolean }> =
  defineFlow({
    site: "unsubscribe",
    name: "link",
    async run(fp, { url }) {
      await fp.open(url);
      const button = { role: "button", name: "/unsubscribe|confirm|yes|opt.?out/i" };
      let pressed = false;
      if (await fp.has(button, 3_000)) {
        await fp.act({ kind: "click" }, button, { goal: "confirm the unsubscribe" });
        await fp.wait(1_500);
        pressed = true;
      }
      return { text: (await fp.text()).slice(0, 300), pressed };
    },
  });

export type LeaveHow = "one-click" | "mailto" | "link" | "none";
export interface Left {
  sender: string;
  how: LeaveHow;
  ok: boolean;
  detail: string;
}

export interface LeaveDeps {
  http: HttpClient;
  /** Sends as the inbox (Gmail's send route); absent = the mailto path is skipped. */
  send?: (raw: string) => Promise<void>;
  from?: string;
  /** Opens links; absent = links are reported, not opened. */
  browser?: FlowRunner;
}

/** Leave one list by the first path it offers that we can take. */
export async function leave(sub: Subscription, d: LeaveDeps): Promise<Left> {
  const out = (how: LeaveHow, ok: boolean, detail: string): Left => ({
    sender: sub.sender,
    how,
    ok,
    detail,
  });
  if (sub.oneClick) {
    const res = await d.http
      .json<unknown>(sub.oneClick, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        raw: "List-Unsubscribe=One-Click",
      })
      .catch((err: Error) => ({ ok: false, status: 0, body: null, headers: new Headers(), err }));
    if (res.ok) return out("one-click", true, `HTTP ${res.status}`);
    // A one-click that fails still leaves the mailto/link paths.
  }
  if (sub.mailto && d.send && d.from) {
    await d.send(rawMail(d.from, sub.mailto.to, sub.mailto.subject));
    return out("mailto", true, `mailed ${sub.mailto.to}`);
  }
  if (sub.link) {
    if (!d.browser) return out("link", false, `open ${sub.link}`);
    const r = await d.browser.run(unsubscribeLink, { url: sub.link });
    return out("link", true, r.pressed ? `pressed confirm · ${r.text}` : r.text);
  }
  return out("none", false, "no path offered");
}

const when = (iso: string) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : t.toISOString().slice(0, 10);
};

/** One line per list, for the person to read before saying yes. */
export function subscriptionLines(rows: readonly Subscription[]): string[] {
  return rows.map(
    (s) =>
      `${String(s.count).padStart(3)}  ${s.sender.padEnd(40)} ${(s.oneClick ? "one-click" : s.mailto ? "mailto" : s.link ? "link" : "none").padEnd(9)} ${when(s.latest.date)}  ${s.latest.subject.slice(0, 60)}`,
  );
}
