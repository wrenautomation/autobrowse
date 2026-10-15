import { describe, expect, it } from "vitest";
import type { Message, MessageReader } from "../src/auth/codes.js";
import {
  bankCodeReader,
  bankCodeSecret,
  CODE_WINDOW_MS,
  codeWindowOpen,
} from "../src/money/bank-code.js";

const INBOX = "+15555550182";
const text = (body: string, at: number, from = "22000"): Message => ({
  from,
  subject: "",
  text: body,
  at: new Date(at),
});
/** Messages' own filter: the reader hands back what is newer than `since`. */
const inbox = (all: Message[]): MessageReader => ({
  recent: async (_i, since) => all.filter((m) => m.at >= since),
});

describe("the bank's code", () => {
  it("names card.code and card@<label>.code, and nothing else", () => {
    expect(bankCodeSecret("card.code")).toEqual({ label: null });
    expect(bankCodeSecret("card@main.code")).toEqual({ label: "main" });
    for (const other of ["code", "card.cvc", "card@main.number", "cards.code", "site.code"])
      expect(bankCodeSecret(other)).toBeNull();
  });

  it("is open for 10 min after the card landed, then closed", () => {
    expect(CODE_WINDOW_MS).toBe(10 * 60_000);
    expect(codeWindowOpen(1_000, 1_000)).toBe(true);
    expect(codeWindowOpen(1_000, 1_000 + CODE_WINDOW_MS)).toBe(true);
    expect(codeWindowOpen(1_000, 1_001 + CODE_WINDOW_MS)).toBe(false);
  });

  it("reads the newest numeric text received after the card, never an older one", async () => {
    const landed = 1_800_000_000_000;
    const read = bankCodeReader(
      inbox([
        text("Your CIBC code is 111111", landed - 60_000),
        text("Your CIBC verification code is 222222. Do not share it.", landed + 5_000),
        text("CIBC code 333333 to confirm your purchase", landed + 9_000),
        text("Meeting at 4, bring code: AB12CD", landed + 12_000),
      ]),
      INBOX,
      { timeoutMs: 0 },
    );
    expect(await read(new Date(landed))).toBe("333333");
  });

  it("takes a text only once: the next read wants one newer than it (a resend)", async () => {
    const landed = 1_800_000_000_000;
    const all = [text("code 222222", landed + 1_000), text("code 333333", landed + 2_000)];
    const read = bankCodeReader(inbox(all), INBOX, { timeoutMs: 0 });
    expect(await read(new Date(landed))).toBe("333333");
    // The older 222222 is not the answer to a second ask.
    expect(await read(new Date(landed))).toBeNull();
    all.push(text("Your new code is 444444", landed + 30_000));
    expect(await read(new Date(landed))).toBe("444444");
  });

  it("waits for the text to land, then gives up with null", async () => {
    const landed = 1_800_000_000_000;
    let t = landed;
    const all: Message[] = [];
    const sleeps: number[] = [];
    const read = bankCodeReader(inbox(all), INBOX, {
      timeoutMs: 10_000,
      pollMs: 3_000,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
        if (sleeps.length === 2) all.push(text("code 765432", t));
      },
    });
    expect(await read(new Date(landed))).toBe("765432");
    expect(sleeps).toEqual([3_000, 3_000]);
    expect(await bankCodeReader(inbox([]), INBOX, { timeoutMs: 0 })(new Date(landed))).toBeNull();
  });
});
