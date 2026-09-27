import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteParameterCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { plainCipher } from "credvault";
import { describe, expect, it } from "vitest";
import {
  backedUpProfiles,
  contactsOf,
  fileProfiles,
  ownerOf,
  type Profile,
  profileSchema,
} from "../src/money/profile.js";
import {
  backedUpWallet,
  type Card,
  cardEnding,
  cardField,
  cardFromFields,
  cardSecret,
  defaultLabel,
  describeCard,
  fileWallet,
  luhn,
  memoryWallet,
  parseCardLine,
  pickCard,
  ssmWallet,
} from "../src/money/wallet.js";

// Public test numbers (Stripe's), never a real card.
const VISA = "4242424242424242";
const MC = "5555555555554444";
const NOW = new Date("2026-09-25T12:00:00Z");
const card = (label: string, kind: Card["kind"], number = VISA): Card =>
  parseCardLine(`${number} 09/28 123`, { label, kind, now: NOW });

describe("wallet cards", () => {
  it("parses a clipboard line, spaced number, postal and name", () => {
    const c = parseCardLine("4242 4242 4242 4242 7/2029 1234 m5v 2t6 Jane Q Doe", {
      label: "visa",
      kind: "credit",
      now: NOW,
    });
    expect(c).toMatchObject({
      number: VISA,
      expMonth: 7,
      expYear: 2029,
      cvc: "1234",
      postal: "M5V2T6",
      holder: "Jane Q Doe",
    });
    expect(card("c", "credit").holder).toBe("William Jin");
    expect(
      parseCardLine(`${VISA} 09/28 123 Jane Doe`, { label: "c", kind: "credit", now: NOW }),
    ).toMatchObject({ holder: "Jane Doe" });
    expect(
      parseCardLine(`${VISA} 09/28 123 Jane Doe`, { label: "c", kind: "credit", now: NOW }).postal,
    ).toBeUndefined();
  });
  it("errors name the part, never the value", () => {
    const bad = (t: string) => () => parseCardLine(t, { label: "c", kind: "credit", now: NOW });
    expect(bad("4242424242424241 09/28 123")).toThrow(/check digit/);
    expect(bad("4242424242424242 08/26 123")).toThrow(/expired/);
    expect(bad("4242424242424242")).toThrow(/^expected/);
    for (const t of ["4242424242424241 09/28 123", "4242424242424242 08/26 999"])
      expect(() => bad(t)()).toThrow(
        expect.not.objectContaining({ message: expect.stringMatching(/4242|999/) }),
      );
  });
  it("describes with brand, kind, last 4, expiry only", () => {
    expect(describeCard(card("main", "credit"))).toBe("main: Visa credit ••4242");
    expect(luhn(MC)).toBe(true);
  });
  it("names the fields place may ask for", () => {
    const c = card("main", "credit");
    expect(
      ["number", "exp", "expMonth", "expYear", "expYY", "cvc", "name"].map((f) => cardField(c, f)),
    ).toEqual([VISA, "09/28", "09", "2028", "28", "123", "William Jin"]);
    expect(cardField(c, "pin")).toBeNull();
    expect(cardSecret("card.cvc")).toEqual({ label: null, field: "cvc" });
    expect(cardSecret("card@debit.number")).toEqual({ label: "debit", field: "number" });
    expect(cardSecret("x.password")).toBeNull();
  });
});

describe("pickCard", () => {
  const w = memoryWallet([card("debit", "debit", MC), card("visa", "credit")]);
  const policy = { debitHosts: ["td.com"] };
  it("credit by default, even with debit listed first", async () => {
    expect(
      (await pickCard(w, { host: "shop.com", label: null, subscription: false, policy })).label,
    ).toBe("visa");
  });
  it("debit only on a listed host, never for a subscription", async () => {
    const debit = (host: string, subscription: boolean) =>
      pickCard(w, { host, label: "debit", subscription, policy });
    expect((await debit("easyweb.td.com", false)).label).toBe("debit");
    await expect(debit("shop.com", false)).rejects.toThrow(/not in WALLET_DEBIT_HOSTS/);
    await expect(debit("td.com", true)).rejects.toThrow(/never for a subscription/);
  });
  it("no credit card is a clear error", async () => {
    await expect(
      pickCard(memoryWallet([]), { host: "a.com", label: null, subscription: false, policy }),
    ).rejects.toThrow(/wallet add/);
  });
});

/** SSM as a map: puts, path reads with paging, deletes. */
function fakeSsm() {
  const params = new Map<string, string>();
  const types: string[] = [];
  return {
    params,
    types,
    // biome-ignore lint/suspicious/noExplicitAny: each command's own output shape
    async send(cmd: unknown): Promise<any> {
      if (cmd instanceof PutParameterCommand) {
        types.push(cmd.input.Type ?? "");
        params.set(cmd.input.Name ?? "", cmd.input.Value ?? "");
        return {};
      }
      if (cmd instanceof GetParametersByPathCommand) {
        const all = [...params].filter(([k]) => k.startsWith(`${cmd.input.Path}/`));
        const from = Number(cmd.input.NextToken ?? 0);
        return {
          Parameters: all.slice(from, from + 1).map(([Name, Value]) => ({ Name, Value })),
          NextToken: from + 1 < all.length ? String(from + 1) : undefined,
        };
      }
      if (cmd instanceof DeleteParameterCommand) {
        if (!params.delete(cmd.input.Name ?? ""))
          throw new ParameterNotFound({ message: "gone", $metadata: {} });
        return {};
      }
      throw new Error("unexpected command");
    },
  };
}

describe("wallet stores", () => {
  it("the file is 0600 and round-trips", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "wallet-")), "wallet.sealed");
    const f = fileWallet(path, plainCipher);
    await f.put(card("visa", "credit"));
    await f.put(card("debit", "debit", MC));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await f.list()).map((c) => c.label)).toEqual(["visa", "debit"]);
    expect(await f.remove("visa")).toBe(true);
    expect(await f.remove("visa")).toBe(false);
  });
  it("every change is backed up to SSM /wallet as a SecureString; restore brings it back", async () => {
    const ssm = fakeSsm();
    const w = backedUpWallet(memoryWallet(), ssmWallet(ssm));
    await w.put(card("visa", "credit"));
    await w.put(card("debit", "debit", MC));
    expect([...ssm.params.keys()]).toEqual(["/wallet/cards/visa", "/wallet/cards/debit"]);
    expect(ssm.types).toEqual(["SecureString", "SecureString"]);
    await w.remove("debit");
    expect([...ssm.params.keys()]).toEqual(["/wallet/cards/visa"]);
    const fresh = backedUpWallet(memoryWallet(), ssmWallet(ssm));
    expect(await fresh.restore()).toEqual(["visa"]);
    expect((await fresh.get("visa"))?.number).toBe(VISA);
  });
  it("a card is its number: a used label is refused, the same number moves label", async () => {
    const w = backedUpWallet(memoryWallet(), ssmWallet(fakeSsm()));
    await w.put(card("main", "credit"));
    // The 2026-09-25 slip: a second card under the same label replaced the first.
    const err = await w.put(card("main", "debit", MC)).catch((e: Error) => e);
    expect((err as Error).message).toMatch(
      /main already names main: Visa credit ••4242.*mastercard-\d{4}/,
    );
    expect((err as Error).message).not.toContain(MC);
    expect(await w.put(card("visa-4242", "credit"))).toEqual({ replaces: "main" });
    expect((await w.list()).map((c) => c.label)).toEqual(["visa-4242"]);
    expect(defaultLabel(MC)).toBe(`mastercard-${MC.slice(-4)}`);
    expect(cardEnding(card("visa-4242", "credit"))).toBe("Visa credit ending 4242");
    expect(cardEnding(card("work", "credit"))).toBe("Visa credit ending 4242 (work)");
  });
  it("a failed backup says the Mac has it and how to rerun, without values", async () => {
    const broken = {
      ...memoryWallet(),
      put: async () => {
        throw Object.assign(new Error(VISA), { name: "ExpiredToken" });
      },
    };
    const local = memoryWallet();
    const w = backedUpWallet(local, broken);
    const err = await w.put(card("visa", "credit")).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/visa: changed on this Mac.*aws-login.*ExpiredToken/);
    expect((err as Error).message).not.toContain(VISA);
    expect(await local.get("visa")).not.toBeNull();
  });
  it("builds a card from one field per prompt, each checked on its own", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    const o = { label: "main", kind: "credit" as const, now };
    const card = cardFromFields(
      { number: "4242 4242 4242 4242", exp: "04/29", cvc: "123", postal: "m5v 2t6" },
      o,
    );
    expect(card).toMatchObject({
      number: "4242424242424242",
      expMonth: 4,
      expYear: 2029,
      postal: "M5V2T6",
      holder: "William Jin",
    });
    const bad = (f: Partial<Parameters<typeof cardFromFields>[0]>) => () =>
      cardFromFields({ number: "4242424242424242", exp: "04/29", cvc: "123", ...f }, o);
    expect(bad({ number: "4242424242424241" })).toThrow(/check digit/);
    expect(bad({ exp: "13/29" })).toThrow(/mm\/yy/);
    expect(bad({ exp: "08/26" })).toThrow(/expired/);
    expect(bad({ cvc: "12" })).toThrow(/CVC/);
    expect(bad({ postal: "hello" })).toThrow(/postal/);
    // An error names the field, never the value.
    expect(bad({ cvc: "98765" })).not.toThrow(/98765/);
  });
});

describe("profiles", () => {
  const home = {
    line1: "1 Main St",
    city: "Edmonton",
    region: "Alberta",
    regionCode: "AB",
    postal: "T6R 0K9",
    country: "CA",
  };
  it("a card's billing fields come from its owner's address; its own postal wins", () => {
    const c = card("visa", "credit");
    expect(cardField(c, "city", home)).toBe("Edmonton");
    expect(cardField(c, "region", home)).toBe("Alberta");
    expect(cardField(c, "countryName", home)).toBe("Canada");
    expect(cardField({ ...c, postal: undefined }, "postal", home)).toBe("T6R 0K9");
    expect(cardField({ ...c, postal: "M5V2T6" }, "postal", home)).toBe("M5V2T6");
    expect(cardField(c, "city")).toBeNull();
  });
  it("a card bills to its owner, else the only profile", () => {
    const a = { id: "william", name: "W" };
    const b = { id: "wren", name: "Wren" };
    expect(ownerOf([a], undefined)?.id).toBe("william");
    expect(ownerOf([a, b], undefined)).toBeNull();
    expect(ownerOf([a, b], "wren")?.id).toBe("wren");
  });
  it("a charge is told to the card's own contacts, else its owner's", () => {
    const owner = profileSchema.parse({
      id: "william",
      name: "W",
      email: "me@x.co",
      phone: "+15551234567",
    });
    expect(contactsOf({}, owner)).toEqual({ email: "me@x.co", phone: "+15551234567" });
    expect(contactsOf({ email: "cards@x.co" }, owner)).toEqual({
      email: "cards@x.co",
      phone: "+15551234567",
    });
    expect(contactsOf({}, null)).toEqual({});
    expect(() => profileSchema.parse({ id: "w", name: "W", phone: "555-1234" })).toThrow();
  });
  it("the file is sealed and backed up; an empty Mac fills from the backup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profiles-"));
    const backup = {
      all: [] as Profile[],
      list: async () => backup.all,
      put: async (p: Profile) => void backup.all.push(p),
    };
    const w = backedUpProfiles(fileProfiles(join(dir, "a.sealed"), plainCipher), backup);
    await w.put({ id: "william", name: "W", address: home });
    expect(backup.all).toHaveLength(1);
    const fresh = backedUpProfiles(fileProfiles(join(dir, "b.sealed"), plainCipher), backup);
    expect((await fresh.list())[0]?.address?.city).toBe("Edmonton");
  });
});
