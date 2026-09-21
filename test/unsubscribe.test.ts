import { describe, expect, it } from "vitest";
import {
  findSubscriptions,
  leave,
  parseFrom,
  parseListUnsubscribe,
  rawMail,
  subscriptionLines,
} from "../src/chores/unsubscribe.js";

const msg = (id: string, headers: Record<string, string>) => ({
  id,
  payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
});

function inbox(messages: ReturnType<typeof msg>[]) {
  const calls: { path: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    mailbox: {
      async call(_m: "GET" | "POST", path: string, input: Record<string, unknown>) {
        calls.push({ path, input });
        if (path === "/gmail/v1/users/me/messages") {
          const second = input.pageToken === "p2";
          const rows = (second ? messages.slice(2) : messages.slice(0, 2)).map((m) => ({
            id: m.id,
          }));
          return {
            messages: rows,
            ...(!second && messages.length > 2 ? { nextPageToken: "p2" } : {}),
          };
        }
        return messages.find((m) => m.id === input.id);
      },
    },
  };
}

describe("unsubscribe", () => {
  it("parses senders and List-Unsubscribe entries", () => {
    expect(parseFrom('"Acme News" <news@Acme.com>')).toEqual({
      name: "Acme News",
      address: "news@acme.com",
    });
    expect(parseFrom("bare@x.io")).toEqual({ name: "bare@x.io", address: "bare@x.io" });
    expect(parseListUnsubscribe("<mailto:u@x.io?subject=unsub>, <https://x.io/u?t=1>")).toEqual({
      https: ["https://x.io/u?t=1"],
      mailto: ["mailto:u@x.io?subject=unsub"],
    });
  });

  it("lists one row per sender that offers a way out, most mail first, never the kept or the headerless", async () => {
    const { mailbox, calls } = inbox([
      msg("1", {
        From: "Registry <noreply@namecheap.com>",
        Subject: "Renew",
        Date: "Mon, 21 Sep 2026 10:00:00 +0000",
        "List-Unsubscribe": "<https://nc.test/u>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }),
      msg("2", {
        From: "Registry <noreply@namecheap.com>",
        Subject: "Sale",
        Date: "Tue, 22 Sep 2026 10:00:00 +0000",
        "List-Unsubscribe": "<https://nc.test/u>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }),
      msg("3", {
        From: "Tool <hi@tool.io>",
        Subject: "Welcome",
        Date: "Sun, 20 Sep 2026 10:00:00 +0000",
        "List-Unsubscribe": "<mailto:leave@tool.io>",
      }),
      msg("4", { From: "Bank <alerts@bank.com>", Subject: "Your code" }),
      msg("5", {
        From: "Wren <hello@wrenautomation.com>",
        Subject: "Digest",
        "List-Unsubscribe": "<https://wren.test/u>",
      }),
    ]);
    const rows = await findSubscriptions(mailbox, { days: 14, keep: ["wrenautomation.com"] });
    expect(rows.map((r) => [r.sender, r.count])).toEqual([
      ["noreply@namecheap.com", 2],
      ["hi@tool.io", 1],
    ]);
    expect(rows[0]).toMatchObject({
      oneClick: "https://nc.test/u",
      latest: { id: "2", subject: "Sale" },
    });
    expect(rows[1]).toMatchObject({ mailto: { to: "leave@tool.io", subject: "unsubscribe" } });
    expect(calls[0]?.input).toMatchObject({ q: "newer_than:14d unsubscribe" });
    expect(calls.filter((c) => c.path.endsWith("{id}"))).toHaveLength(5);
    expect(subscriptionLines(rows)[0]).toMatch(
      /^ {2}2 {2}noreply@namecheap.com\s+one-click 2026-09-22 {2}Sale$/,
    );
  });

  it("leaves by one-click, falls back to mailto, reports a link without a browser", async () => {
    const posts: { url: string; raw?: string }[] = [];
    let status = 200;
    const http = {
      async json(url: string, req: { raw?: string } = {}) {
        posts.push({ url, ...(req.raw ? { raw: req.raw } : {}) });
        return { status, ok: status < 400, body: null, headers: new Headers() };
      },
    };
    const sent: string[] = [];
    const base = {
      sender: "n@x.io",
      name: "n",
      domain: "x.io",
      count: 1,
      latest: { id: "1", subject: "s", date: "" },
    };
    const deps = { http, from: "me@gmail.com", send: async (raw: string) => void sent.push(raw) };
    expect(
      await leave(
        { ...base, oneClick: "https://x.io/u", mailto: { to: "l@x.io", subject: "u" } },
        deps,
      ),
    ).toMatchObject({ how: "one-click", ok: true });
    expect(posts).toEqual([{ url: "https://x.io/u", raw: "List-Unsubscribe=One-Click" }]);
    status = 500;
    expect(
      await leave(
        { ...base, oneClick: "https://x.io/u", mailto: { to: "l@x.io", subject: "u" } },
        deps,
      ),
    ).toMatchObject({ how: "mailto", ok: true });
    expect(Buffer.from(sent[0] ?? "", "base64url").toString()).toContain(
      "To: l@x.io\r\nSubject: u",
    );
    expect(await leave({ ...base, link: "https://x.io/leave" }, deps)).toEqual({
      sender: "n@x.io",
      how: "link",
      ok: false,
      detail: "open https://x.io/leave",
    });
    expect(await leave(base, deps)).toMatchObject({ how: "none", ok: false });
    expect(rawMail("a@b", "c@d", "s")).toBe(
      Buffer.from(
        "From: a@b\r\nTo: c@d\r\nSubject: s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nunsubscribe",
      ).toString("base64url"),
    );
  });
});
