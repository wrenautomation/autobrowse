import { describe, expect, it } from "vitest";
import { mimeMessage, rawHeader } from "../src/clients/gmail.js";
import {
  type Charge,
  type ChargeRow,
  chargeMail,
  type Invoice,
  receiptOutcome,
  reportCharge,
  stillAsking,
} from "../src/money/charges.js";

const CHARGE: Charge = {
  at: "2026-09-25T15:00:00.000Z",
  site: "racknerd",
  host: "my.racknerd.com",
  url: "https://my.racknerd.com/cart.php",
  what: 'press "Complete order", which spends',
  amount: { value: 11.29, currency: "USD", per: "year" },
  card: "main: Visa credit ••4242",
  recurring: true,
  outcome: "charged",
};
const INVOICE: Invoice = {
  from: "RackNerd <billing@racknerd.com>",
  subject: "Invoice #123 paid",
  at: new Date("2026-09-25T15:01:00Z"),
  raw: Buffer.from("From: billing@racknerd.com\r\nSubject: Invoice #123 paid\r\n\r\nThanks"),
};
const instant = async () => undefined;

describe("charges", () => {
  it("the mail carries amount, host, card and the receipt screenshot", () => {
    const m = chargeMail(CHARGE, { text: "Order #1 paid", png: Buffer.from("png") });
    expect(m.subject).toMatch(/^Charge: .*11\.29.* at my\.racknerd\.com$/);
    expect(m.text).toContain("Card: main: Visa credit ••4242");
    expect(m.text).toContain("(recurring)");
    expect(m.text).toContain("Order #1 paid");
    expect(m.attachments).toEqual([
      { name: "receipt-2026-09-25.png", type: "image/png", data: Buffer.from("png") },
    ]);
  });
  it("a failed channel never hides the charge: the ledger says who heard", async () => {
    const rows: unknown[] = [];
    const told = await reportCharge(
      {
        ledger: { append: async (r) => void rows.push(r) },
        text: async () => {
          throw new Error("phone off");
        },
        email: async () => undefined,
      },
      CHARGE,
      { text: "" },
    );
    expect(told.told).toEqual(["email"]);
    expect(rows).toEqual([{ ...CHARGE, told: ["email"] }]);
  });
  it("the landing page decides the word: paid, declined, or check", () => {
    expect(receiptOutcome("Thank you for your order! Order number 4411")).toBe("charged");
    expect(receiptOutcome("Your card was declined. Try another card.")).toBe("declined");
    expect(receiptOutcome("Payment failed: insufficient funds")).toBe("declined");
    expect(receiptOutcome("Your purchase couldn’t be completed. Check your card details")).toBe(
      "declined",
    );
    expect(receiptOutcome("Loading…")).toBe("unclear");
    expect(receiptOutcome("Order confirmed. If a payment was declined we email you")).toBe(
      "unclear",
    );
    const declined = chargeMail({ ...CHARGE, outcome: "declined" }, { text: "" });
    expect(declined.subject).toMatch(/^Declined: .* \(not charged\)$/);
    expect(declined.text).not.toContain("invoice follows");
    expect(chargeMail({ ...CHARGE, outcome: "unclear" }, { text: "" }).subject).toMatch(/^Check: /);
  });
  it("after a charge the merchant's invoice is forwarded whole, once it arrives", async () => {
    const rows: ChargeRow[] = [];
    const mails: { subject: string; attachments: { type: string }[] }[] = [];
    let looks = 0;
    const r = await reportCharge(
      {
        ledger: { append: async (row) => void rows.push(row) },
        email: async (m) => void mails.push(m),
        invoice: async (_c, since) => {
          expect(since.toISOString()).toBe("2026-09-25T14:59:00.000Z");
          return ++looks < 3 ? null : INVOICE;
        },
        sleep: instant,
      },
      CHARGE,
      { text: "" },
      { everyMs: 1, forMs: 10 },
    );
    expect(await r.invoice).toBe(true);
    expect(looks).toBe(3);
    expect(mails[1]?.subject).toBe("Invoice: my.racknerd.com: Invoice #123 paid");
    expect(mails[1]?.attachments[0]?.type).toBe("message/rfc822");
    expect(rows[1]).toMatchObject({
      invoiceFor: CHARGE.at,
      subject: "Invoice #123 paid",
      told: ["email"],
    });
  });
  it("a decline watches for no invoice; a watch that finds none ends", async () => {
    let looks = 0;
    const deps = {
      ledger: { append: async () => undefined },
      email: async () => undefined,
      invoice: async () => {
        looks++;
        return null;
      },
      sleep: instant,
    };
    expect(
      await (await reportCharge(deps, { ...CHARGE, outcome: "declined" }, { text: "" })).invoice,
    ).toBe(false);
    expect(looks).toBe(0);
    const r = await reportCharge(deps, CHARGE, { text: "" }, { everyMs: 1, forMs: 3 });
    expect(await r.invoice).toBe(false);
    expect(looks).toBe(3);
  });
  it("reads headers from a raw message, folded lines joined", () => {
    const raw = Buffer.from("From: a@x.co\r\nSubject: Your\r\n  receipt\r\n\r\nSubject: body");
    expect(rawHeader(raw, "subject")).toBe("Your receipt");
    expect(rawHeader(raw, "to")).toBe("");
  });
  it("decodes RFC 2047 encoded words in a header", () => {
    const b64 = Buffer.from("Votre reçu n°42").toString("base64");
    const raw = Buffer.from(
      `From: =?UTF-8?Q?Caf=C3=A9_Billing?= <b@x.example>\r\nSubject: =?UTF-8?B?${b64}?=\r\n =?ISO-8859-1?Q?_=E9t=E9?=\r\n\r\nbody`,
    );
    expect(rawHeader(raw, "subject")).toBe("Votre reçu n°42 été");
    expect(rawHeader(raw, "from")).toBe("Café Billing <b@x.example>");
  });
  it("mail with a file is multipart/mixed; without, plain text", async () => {
    const base = { from: "a@x.co", to: "b@x.co", subject: "s", text: "hi" };
    const plain = await mimeMessage(base);
    expect(plain).toContain("Content-Type: text/plain; charset=utf-8");
    expect(plain).toContain("Subject: s\r\n");
    expect(plain.endsWith("\r\n\r\nhi\r\n")).toBe(true);
    const raw = await mimeMessage({
      ...base,
      attachments: [{ name: "r.png", type: "image/png", data: Buffer.alloc(100, 1) }],
    });
    const b = /boundary="([^"]+)"/.exec(raw)?.[1];
    expect(b).toBeTruthy();
    expect(raw.split(`--${b}`)).toHaveLength(4); // preamble, text, file, close
    expect(raw).toContain("Content-Disposition: attachment; filename=r.png");
    expect(raw).toContain(Buffer.alloc(100, 1).toString("base64").slice(0, 76));
    expect(raw.trimEnd().endsWith(`--${b}--`)).toBe(true);
  });
});

describe("mimeMessage headers", () => {
  const head = (raw: string) => raw.split("\r\n\r\n")[0]?.split("\r\n") ?? [];
  it("a subject carrying CRLF never becomes a second header", async () => {
    const raw = await mimeMessage({
      from: "a@x.example",
      to: "b@x.example",
      subject: "Receipt\r\nBcc: evil@x.example",
      text: "hi",
    });
    expect(head(raw).some((l) => /^bcc:/i.test(l))).toBe(false);
  });
  it("non-ASCII subjects and file names are encoded; headers stay ASCII", async () => {
    const raw = await mimeMessage({
      from: "a@x.example",
      to: "b@x.example",
      subject: "Reçu de paiement €5",
      text: "hi",
      attachments: [{ name: 'reçu "1".png', type: "image/png", data: Buffer.alloc(10, 1) }],
    });
    expect(head(raw).every((l) => /^[\x20-\x7e\t]*$/.test(l))).toBe(true);
    const disposition = raw.split("\r\n").find((l) => /^content-disposition: attachment/i.test(l));
    expect(disposition).toBeTruthy();
    expect(disposition).not.toContain('"1"');
    expect(raw.split("\r\n").every((l) => /^[\x20-\x7e\t]*$/.test(l))).toBe(true);
  });
});

describe("still asking", () => {
  it("an unpaid invoice or a card form is the next step, not a charge", () => {
    expect(stillAsking("Invoice #25429776 UNPAID Pay Now Total $21.99")).toBe(true);
    expect(stillAsking("Enter New Card Information Below Card Number Submit Payment")).toBe(true);
    expect(stillAsking("Thank you for your order. Invoice #123 Pay now")).toBe(false);
    expect(stillAsking("Your plan is active")).toBe(false);
  });
});
