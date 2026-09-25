import { describe, expect, it } from "vitest";
import { mimeMessage } from "../src/clients/gmail.js";
import { type Charge, chargeMail, reportCharge } from "../src/money/charges.js";

const CHARGE: Charge = {
  at: "2026-09-25T15:00:00.000Z",
  site: "racknerd",
  host: "my.racknerd.com",
  url: "https://my.racknerd.com/cart.php",
  what: 'press "Complete order", which spends',
  amount: { value: 11.29, currency: "USD", per: "year" },
  card: "main: Visa credit ••4242 exp 09/30",
  recurring: true,
};

describe("charges", () => {
  it("the mail carries amount, host, card and the receipt screenshot", () => {
    const m = chargeMail(CHARGE, { text: "Order #1 paid", png: Buffer.from("png") });
    expect(m.subject).toMatch(/^Charge: .*11\.29.* at my\.racknerd\.com$/);
    expect(m.text).toContain("Card: main: Visa credit ••4242 exp 09/30");
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
    expect(told).toEqual(["email"]);
    expect(rows).toEqual([{ ...CHARGE, told: ["email"] }]);
  });
  it("mail with a file is multipart/mixed; without, plain text", () => {
    const base = { from: "a@x.co", to: "b@x.co", subject: "s", text: "hi" };
    expect(mimeMessage(base)).toContain('Content-Type: text/plain; charset="UTF-8"\r\n\r\nhi');
    const raw = mimeMessage({
      ...base,
      attachments: [{ name: "r.png", type: "image/png", data: Buffer.alloc(100, 1) }],
    });
    const b = /boundary="([^"]+)"/.exec(raw)?.[1];
    expect(b).toBeTruthy();
    expect(raw.split(`--${b}`)).toHaveLength(4); // preamble, text, file, close
    expect(raw).toContain('Content-Disposition: attachment; filename="r.png"');
    expect(raw).toContain(Buffer.alloc(100, 1).toString("base64").slice(0, 76));
    expect(raw.endsWith(`--${b}--`)).toBe(true);
  });
});
