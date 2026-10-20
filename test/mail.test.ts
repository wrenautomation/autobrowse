/**
 * The `./mail` piece: `ImapReader` against an in-memory IMAP fake, `RoutedReader`, and
 * `InstantlyReader` against a fake fetch. Synthetic data only.
 */
import type { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/clients/http.js";
import { ImapReader, InstantlyReader, type Login, RoutedReader, rawOf } from "../src/mail/index.js";

const ANN = "ann@example.com";
const LOGIN: Login = { host: "127.0.0.1", port: 993, user: ANN, pass: "pw" };

// ---------------------------------------------------------------------------
// A fake IMAP server's client: folders of raw messages, every open recorded.

interface Stored {
  uid: number;
  raw: Buffer;
  date: Date;
}
interface Folder {
  specialUse?: string;
  uidValidity: bigint;
  messages: Stored[];
}

/** The header fields of `raw` named in `names` (folded lines kept), as a server returns them. */
function headerFields(raw: Buffer, names: readonly string[]): Buffer {
  const head = raw.toString("utf8").split("\r\n\r\n")[0] ?? "";
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const fields = head.split(/\r\n(?![ \t])/);
  const kept = fields.filter((f) => wanted.has(f.slice(0, f.indexOf(":")).toLowerCase()));
  return Buffer.from(`${kept.join("\r\n")}\r\n\r\n`);
}

class FakeImap {
  folders = new Map<string, Folder>();
  mailbox: { uidValidity: bigint } | false = false;
  opened: { path: string; readOnly: boolean }[] = [];
  down = false;
  private current = "";

  on() {
    return this;
  }
  async connect() {
    if (this.down) throw new Error("connect ECONNREFUSED");
  }
  async logout() {}
  close() {}
  async list() {
    return [...this.folders].map(([path, f]) => ({ path, specialUse: f.specialUse }));
  }
  async getMailboxLock(path: string, opts?: { readOnly?: boolean }) {
    const folder = this.folders.get(path);
    if (!folder) throw new Error(`no folder ${path}`);
    this.opened.push({ path, readOnly: opts?.readOnly ?? false });
    this.current = path;
    this.mailbox = { uidValidity: folder.uidValidity };
    return { release: () => (this.mailbox = false) };
  }
  private here(): Stored[] {
    return this.folders.get(this.current)?.messages ?? [];
  }
  private shape(m: Stored, q: { internalDate?: boolean; headers?: string[]; source?: boolean }) {
    return {
      uid: m.uid,
      ...(q.internalDate ? { internalDate: m.date } : {}),
      ...(q.headers ? { headers: headerFields(m.raw, q.headers) } : {}),
      ...(q.source ? { source: m.raw } : {}),
    };
  }
  async fetchAll(range: { since: Date }, q: { headers?: string[] }) {
    // SINCE compares whole days.
    const day = range.since.toISOString().slice(0, 10);
    return this.here()
      .filter((m) => m.date.toISOString().slice(0, 10) >= day)
      .map((m) => this.shape(m, { ...q, internalDate: true }));
  }
  async fetchOne(uid: string, q: { internalDate?: boolean; headers?: string[]; source?: boolean }) {
    const m = this.here().find((x) => String(x.uid) === uid);
    return m ? this.shape(m, q) : false;
  }
}

function fakeImap(): FakeImap {
  const imap = new FakeImap();
  imap.folders.set("INBOX", { uidValidity: 11n, messages: [] });
  imap.folders.set("Sent Items", { specialUse: "\\Sent", uidValidity: 7n, messages: [] });
  imap.folders.set("Junk", { specialUse: "\\Junk", uidValidity: 12n, messages: [] });
  return imap;
}
const asClient = (imap: FakeImap) => () => imap as unknown as ImapFlow;

const inbox = "sender@example.com";

function fakeFetch(pages: Record<string, unknown>[]) {
  const asked: string[] = [];
  const f = (async (url: string) => {
    asked.push(url);
    const page = pages.shift() ?? { items: [] };
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as FetchLike;
  return { f, asked };
}

const email = (id: string, at: string, ue_type = 2) => ({
  id,
  timestamp_email: at,
  message_id: `<${id}@mail.example.net>`,
  subject: "Re: a question",
  from_address_email: "lead@example.net",
  from_address_json: [{ address: "lead@example.net", name: "Lea Doe" }],
  to_address_email_list: inbox,
  body: { text: "Yes, send more.\nThanks" },
  eaccount: inbox,
  ue_type,
});

describe("InstantlyReader", () => {
  it("lists received mail after the cursor across pages, newest first, and stops at older mail", async () => {
    const { f, asked } = fakeFetch([
      {
        items: [email("a", "2026-10-10T12:00:00Z"), email("s", "2026-10-10T11:00:00Z", 1)],
        next_starting_after: "s",
      },
      { items: [email("b", "2026-10-09T12:00:00Z"), email("old", "2026-10-01T00:00:00Z")] },
    ]);
    const reader = new InstantlyReader({ apiKey: "k", fetch: f });
    const after = Date.parse("2026-10-05T00:00:00Z") / 1000;
    const [ids, next] = await reader.listMessages(inbox, `after:${after}`);
    expect(ids).toEqual(["instantly:a", "instantly:b"]);
    expect(next).toBeNull();
    expect(asked[0]).toContain("mode=emode_all");
    expect(asked[0]).toContain(`eaccount=${encodeURIComponent(inbox)}`);
    expect(asked[1]).toContain("starting_after=s");

    const meta = await reader.getMetadata(inbox, "instantly:a");
    expect(meta.internalDate).toBe(String(Date.parse("2026-10-10T12:00:00Z")));
    expect(meta.payload).toMatchObject({
      headers: expect.arrayContaining([
        { name: "From", value: '"Lea Doe" <lead@example.net>' },
        { name: "Message-ID", value: "<a@mail.example.net>" },
      ]),
    });
  });

  it("writes a plain RFC 822 message, HTML stripped when there is no text body", () => {
    const raw = rawOf({
      ...email("h", "2026-10-10T12:00:00Z"),
      body: { html: "<p>Hi<br>there</p>" },
    });
    expect(raw).toContain("Subject: Re: a question\r\n");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
    expect(raw.split("\r\n\r\n")[1]).toBe("Hi\r\nthere\r\n");
  });

  it("refuses an id that is not Instantly's", async () => {
    const reader = new InstantlyReader({ apiKey: "k", fetch: fakeFetch([]).f });
    await expect(reader.getRaw(inbox, "inbox:1:2:abc")).rejects.toThrow(/not an Instantly id/);
  });
});

describe("ImapReader", () => {
  const AFTER = Date.parse("2026-10-05T12:00:00Z") / 1000;
  const reply = (id: string) =>
    Buffer.from(
      `Message-ID: <${id}@example.org>\r\nFrom: Lead <lead@example.org>\r\nSubject: Re: A question\r\n` +
        `References: <m0@example.com>\r\n <m1@example.com>\r\nX-Other: not asked for\r\n\r\nYes please.\r\n`,
    );
  function stocked(): FakeImap {
    const imap = fakeImap();
    imap.folders.get("INBOX")?.messages.push(
      { uid: 1, raw: reply("old"), date: new Date("2026-10-05T09:00:00Z") }, // before `after`
      { uid: 2, raw: reply("r1"), date: new Date("2026-10-05T14:00:00Z") },
    );
    imap.folders
      .get("Junk")
      ?.messages.push({ uid: 9, raw: reply("r2"), date: new Date("2026-10-06T08:00:00Z") });
    // Sent is never read.
    imap.folders
      .get("Sent Items")
      ?.messages.push({ uid: 5, raw: reply("ours"), date: new Date("2026-10-06T08:00:00Z") });
    return imap;
  }

  it("lists INBOX and spam after the cursor, ids tagged by folder, validity and inbox", async () => {
    const imap = stocked();
    const reader = new ImapReader(LOGIN, { imap: asClient(imap) });
    const [ids, next] = await reader.listMessages(ANN, `after:${AFTER} -in:sent -in:draft`);
    expect(next).toBeNull();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^inbox:11:2:[0-9a-f]{8}$/);
    expect(ids[1]).toMatch(/^spam:12:9:[0-9a-f]{8}$/);
    expect(imap.opened.map((o) => o.path)).toEqual(["INBOX", "Junk"]);
    expect(imap.opened.every((o) => o.readOnly)).toBe(true);
  });

  it("metadata comes back in Gmail's shape, the asked headers unfolded", async () => {
    const imap = stocked();
    const reader = new ImapReader(LOGIN, { imap: asClient(imap) });
    const [ids] = await reader.listMessages(ANN, `after:${AFTER}`);
    const id = ids[0] as string;
    const expected = {
      payload: {
        headers: [
          { name: "Message-ID", value: "<r1@example.org>" },
          { name: "From", value: "Lead <lead@example.org>" },
          { name: "Subject", value: "Re: A question" },
          { name: "References", value: "<m0@example.com> <m1@example.com>" },
        ],
      },
      internalDate: String(Date.parse("2026-10-05T14:00:00Z")),
      threadId: null,
    };
    expect(await reader.getMetadata(ANN, id)).toEqual(expected);
    // A fresh reader (no listing cached) fetches the same shape.
    const cold = new ImapReader(LOGIN, { imap: asClient(imap) });
    expect(await cold.getMetadata(ANN, id)).toEqual(expected);
    expect(Buffer.from(await cold.getRaw(ANN, id)).toString("utf8")).toContain("Yes please.");
  });

  it("refuses an id from another inbox or a renumbered folder", async () => {
    const imap = stocked();
    const reader = new ImapReader(LOGIN, { imap: asClient(imap) });
    const [ids] = await reader.listMessages(ANN, `after:${AFTER}`);
    const id = ids[0] as string;
    await expect(reader.getRaw("bo@example.com", id)).rejects.toThrow(/not an id from/);
    const inbox = imap.folders.get("INBOX");
    if (inbox) inbox.uidValidity = 99n;
    await expect(reader.getRaw(ANN, id)).rejects.toThrow(/renumbered/);
  });

  it("RoutedReader sends each inbox to its own reader", async () => {
    const reader = new ImapReader(LOGIN, { imap: asClient(stocked()) });
    const gmailCalls: string[] = [];
    const gmail = {
      listMessages: async (sender: string) => {
        gmailCalls.push(sender);
        return [[], null] as [string[], null];
      },
      getMetadata: async () => ({}),
      getRaw: async () => new Uint8Array(),
    };
    const routed = new RoutedReader(gmail, new Map([[ANN, reader]]));
    expect((await routed.listMessages("Ann@example.com", `after:${AFTER}`, {}))[0]).toHaveLength(2);
    await routed.listMessages("will@example.com", `after:${AFTER}`, {});
    expect(gmailCalls).toEqual(["will@example.com"]);
  });
});
