/**
 * The wallet: William's cards, kept harder than passwords.
 *
 * - One sealed file on this Mac, its own keychain key: what `place` reads.
 *   Backed up to SSM under /wallet (SecureString), a path both machine roles
 *   are denied outright (terraform `NeverTheWallet`): the backup outlives the
 *   Mac, and no box, Lambda, env or git ever holds a card.
 * - Nothing prints a number, expiry or CVC: listings say brand, kind, last 4.
 * - A card only lands on a page through explore's `place{secret:"card.number"}`
 *   after a person said yes to that card on that host (see explore/server.ts).
 * - Credit is the card. Debit only on hosts named in `WALLET_DEBIT_HOSTS`
 *   (banking, government: strict places), and never for a subscription.
 * - Every charge is texted and emailed with its receipt (money/charges.ts).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParameterHistoryCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import type { Cipher } from "credvault";
import { z } from "zod";
import { type Address, addressField } from "./profile.js";

export const cardSchema = z.object({
  label: z.string().regex(/^[a-z0-9-]+$/, "label: lowercase letters, digits, dashes"),
  kind: z.enum(["credit", "debit"]),
  holder: z.string().min(1),
  number: z.string().regex(/^\d{12,19}$/),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int().min(2000).max(2100),
  cvc: z.string().regex(/^\d{3,4}$/),
  postal: z.string().optional(),
  /** The profile it bills to (`autobrowse profile`); absent: the only profile. */
  owner: z.string().optional(),
  addedAt: z.string(),
});
export type Card = z.infer<typeof cardSchema>;

/** Luhn: a mistyped digit fails here, not at a checkout. */
export function luhn(number: string): boolean {
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let d = Number(number[number.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return number.length >= 12 && sum % 10 === 0;
}

export function cardBrand(number: string): string {
  if (/^4/.test(number)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(number)) return "Mastercard";
  if (/^3[47]/.test(number)) return "Amex";
  if (/^6(011|5)/.test(number)) return "Discover";
  return "Card";
}

/** What a person reads about a card: never more than this. */
export function describeCard(
  c: Pick<Card, "label" | "kind" | "number" | "expMonth" | "expYear">,
): string {
  const exp = `${String(c.expMonth).padStart(2, "0")}/${String(c.expYear).slice(-2)}`;
  return `${c.label}: ${cardBrand(c.number)} ${c.kind} ••${c.number.slice(-4)} exp ${exp}`;
}

/** A card's own name unless given one: brand and last 4 ("mastercard-4445"). */
export function defaultLabel(number: string): string {
  return `${cardBrand(number)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}-${number.slice(-4)}`;
}

/**
 * A card is its number: the same number again updates it (its old label
 * goes), and a label that already names another card is refused, so a
 * second `add` never silently replaces the first (2026-09-25: a credit card
 * saved as "main" was overwritten by a debit card 32 s later).
 */
export function admitCard(cards: Card[], card: Card): { replaces: string | null } {
  const taken = cards.find((c) => c.label === card.label && c.number !== card.number);
  if (taken)
    throw new Error(
      `${card.label} already names ${describeCard(taken)}; pick another label (or leave it out for ${defaultLabel(card.number)})`,
    );
  const same = cards.find((c) => c.number === card.number && c.label !== card.label);
  return { replaces: same?.label ?? null };
}

/** How a charge names its card: "Mastercard credit ending 4445" (a label of his own added). */
export function cardEnding(c: Pick<Card, "label" | "kind" | "number">): string {
  const own = c.label === defaultLabel(c.number) ? "" : ` (${c.label})`;
  return `${cardBrand(c.number)} ${c.kind} ending ${c.number.slice(-4)}${own}`;
}

/**
 * The clipboard line: `number mm/yy cvc [postal] name…` (spaces or dashes in
 * the number are fine). Errors name the part that is wrong, never its value.
 */
export function parseCardLine(
  text: string,
  o: { label: string; kind: Card["kind"]; now?: Date },
): Card {
  // Number groups (spaces or dashes) up to the month; a postal code is Canadian or US shaped.
  const m =
    /^([\d -]{12,23}?)\s+(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s+(\d{3,4})(?:\s+([A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d|\d{5}(?:-\d{4})?))?(?:\s+(.+))?$/.exec(
      text.trim(),
    );
  const digits = m?.[1]?.replace(/[ -]/g, "") ?? "";
  if (!m || !/^\d{12,19}$/.test(digits))
    throw new Error(
      "expected `number mm/yy cvc [postal] [name on card]` on one line (the clipboard was left as is)",
    );
  const [, , mm = "", yy = "", cvc = "", postal, name] = m;
  return cardFromFields(
    {
      number: digits,
      exp: `${mm}/${yy}`,
      cvc,
      ...(postal ? { postal } : {}),
      ...(name ? { name } : {}),
    },
    o,
  );
}

export interface CardFields {
  number: string;
  /** `mm/yy` or `mm/yyyy`. */
  exp: string;
  cvc: string;
  postal?: string;
  name?: string;
}

/** Each field checked on its own: errors name the field, never its value. */
export const cardChecks = {
  number(v: string): string {
    const n = v.replace(/[ -]/g, "");
    if (!/^\d{12,19}$/.test(n)) throw new Error("the number: 12 to 19 digits");
    if (!luhn(n)) throw new Error("the number fails its check digit: a digit is off");
    return n;
  },
  exp(v: string, now = new Date()): { expMonth: number; expYear: number } {
    const m = /^(\d{1,2})\s*\/?\s*(\d{2}|\d{4})$/.exec(v.trim());
    const expMonth = Number(m?.[1]);
    if (!m || expMonth < 1 || expMonth > 12) throw new Error("the expiry: mm/yy");
    const yy = m[2] as string;
    const expYear = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
    if (
      expYear < now.getFullYear() ||
      (expYear === now.getFullYear() && expMonth < now.getMonth() + 1)
    )
      throw new Error("the card has expired");
    return { expMonth, expYear };
  },
  cvc(v: string): string {
    if (!/^\d{3,4}$/.test(v.trim())) throw new Error("the CVC: 3 or 4 digits");
    return v.trim();
  },
  postal(v: string): string | undefined {
    const p = v.replace(/\s/g, "").toUpperCase();
    if (!p) return undefined;
    if (!/^([A-Z]\d[A-Z]\d[A-Z]\d|\d{5}(-\d{4})?)$/.test(p))
      throw new Error("the postal code: Canadian (A1A 1A1) or US (12345)");
    return p;
  },
};

export function cardFromFields(
  f: CardFields,
  o: { label: string; kind: Card["kind"]; now?: Date },
): Card {
  const now = o.now ?? new Date();
  const postal = cardChecks.postal(f.postal ?? "");
  return cardSchema.parse({
    label: o.label,
    kind: o.kind,
    holder: f.name?.trim() || "William Jin",
    number: cardChecks.number(f.number),
    ...cardChecks.exp(f.exp, now),
    cvc: cardChecks.cvc(f.cvc),
    ...(postal ? { postal } : {}),
    addedAt: now.toISOString(),
  });
}

export interface Wallet {
  list(): Promise<Card[]>;
  get(label: string): Promise<Card | null>;
  put(card: Card): Promise<unknown>;
  remove(label: string): Promise<boolean>;
}

export function memoryWallet(cards: Card[] = []): Wallet {
  const all = new Map(cards.map((c) => [c.label, c]));
  return {
    list: async () => [...all.values()],
    get: async (l) => all.get(l) ?? null,
    put: async (c) => void all.set(c.label, cardSchema.parse(c)),
    remove: async (l) => all.delete(l),
  };
}

/** The sealed file: written whole, 0600, through a rename so a crash never leaves half a wallet. */
export function fileWallet(path: string, cipher: Cipher): Wallet {
  const read = (): Card[] =>
    existsSync(path)
      ? z.array(cardSchema).parse(JSON.parse(cipher.open(readFileSync(path, "utf8"))))
      : [];
  const write = (cards: Card[]) => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, cipher.seal(JSON.stringify(cards)), { mode: 0o600 });
    renameSync(tmp, path);
  };
  return {
    list: async () => read(),
    get: async (l) => read().find((c) => c.label === l) ?? null,
    put: async (card) =>
      write([...read().filter((c) => c.label !== card.label), cardSchema.parse(card)]),
    async remove(l) {
      const cards = read();
      const left = cards.filter((c) => c.label !== l);
      if (left.length === cards.length) return false;
      write(left);
      return true;
    },
  };
}

/** Where the backup lives: out of every machine role's reach (deploy/terraform box.tf, wren postgres.tf). */
export const WALLET_SSM_PATH = "/wallet/cards";

/** One SecureString per card at `<path>/<label>`: written by the Mac's AWS user, never read by a machine. */
export interface VersionedWallet extends Wallet {
  history(label: string): Promise<{ version: number; about: string; at: string }[]>;
  version(label: string, v: number): Promise<Card>;
}

export function ssmWallet(ssm: Pick<SSMClient, "send">, path = WALLET_SSM_PATH): VersionedWallet {
  async function list(): Promise<Card[]> {
    const out: Card[] = [];
    let NextToken: string | undefined;
    do {
      const r = await ssm.send(
        new GetParametersByPathCommand({ Path: path, WithDecryption: true, NextToken }),
      );
      for (const p of r.Parameters ?? []) out.push(cardSchema.parse(JSON.parse(p.Value ?? "")));
      NextToken = r.NextToken;
    } while (NextToken);
    return out;
  }
  return {
    list,
    get: async (l) => (await list()).find((c) => c.label === l) ?? null,
    /** Every stored version of a label: number, brand and kind (the description), when. */
    async history(l: string) {
      const out: { version: number; about: string; at: string }[] = [];
      let NextToken: string | undefined;
      do {
        const r = await ssm.send(
          new GetParameterHistoryCommand({
            Name: `${path}/${l}`,
            WithDecryption: false,
            NextToken,
          }),
        );
        for (const p of r.Parameters ?? [])
          out.push({
            version: p.Version ?? 0,
            about: (p.Description ?? "").replace(/^wallet backup: /, ""),
            at: p.LastModifiedDate?.toISOString() ?? "",
          });
        NextToken = r.NextToken;
      } while (NextToken);
      return out;
    },
    /** One earlier version of a label, whole. */
    async version(l: string, v: number) {
      const r = await ssm.send(
        new GetParameterCommand({ Name: `${path}/${l}:${v}`, WithDecryption: true }),
      );
      return cardSchema.parse(JSON.parse(r.Parameter?.Value ?? ""));
    },
    async put(card) {
      const c = cardSchema.parse(card);
      await ssm.send(
        new PutParameterCommand({
          Name: `${path}/${c.label}`,
          Value: JSON.stringify(c),
          Type: "SecureString",
          Overwrite: true,
          // Describe is readable fleet-wide (names and descriptions): brand and kind only.
          Description: `wallet backup: ${cardBrand(c.number)} ${c.kind}`,
        }),
      );
    },
    async remove(l) {
      try {
        await ssm.send(new DeleteParameterCommand({ Name: `${path}/${l}` }));
        return true;
      } catch (err) {
        if (err instanceof ParameterNotFound || (err as Error).name === "ParameterNotFound")
          return false;
        throw err;
      }
    },
  };
}

/**
 * The file, backed up on every change. Reads never leave the Mac. A backup
 * write that fails fails the command after the file has the change, so the
 * message says to rerun (a put is idempotent), never that nothing happened.
 */
export function backedUpWallet(
  local: Wallet,
  backup: Wallet & Partial<Pick<VersionedWallet, "history" | "version">>,
) {
  const also = async (what: string, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (err) {
      throw new Error(
        `${what}: changed on this Mac, but its SSM backup failed (rerun once AWS is signed in: autobrowse aws-login): ${(err as Error).name}`,
      );
    }
  };
  return {
    list: local.list,
    get: local.get,
    /** Admitted first (`admitCard`); the same number under an old label moves to this one. */
    async put(card: Card) {
      const { replaces } = admitCard(await local.list(), card);
      await local.put(card);
      await also(card.label, () => backup.put(card));
      if (replaces) {
        await local.remove(replaces);
        await also(replaces, () => backup.remove(replaces));
      }
      return { replaces };
    },
    async remove(l: string) {
      const had = await local.remove(l);
      await also(l, () => backup.remove(l));
      return had;
    },
    /** Every backed-up card into the file; the labels restored. */
    async restore() {
      const cards = await backup.list();
      for (const c of cards) await local.put(c);
      return cards.map((c) => c.label);
    },
    /** The backup's versions of a label (SSM keeps each put). */
    history: (l: string) => {
      if (!backup.history) throw new Error("this backup keeps no history");
      return backup.history(l);
    },
    /** An earlier version back into the wallet, under its own default label (or `as`). */
    async recover(l: string, v: number, as?: string) {
      if (!backup.version) throw new Error("this backup keeps no history");
      const old = await backup.version(l, v);
      const card = { ...old, label: as ?? defaultLabel(old.number) };
      await this.put(card);
      return card;
    },
    /** Every card in the file to SSM again: after a backup that failed. */
    async backup() {
      const cards = await local.list();
      for (const c of cards) await backup.put(c);
      return cards.map((c) => c.label);
    },
  };
}

/** The fields `place` may ask for, by name after `card.` (or `card@<label>.`). */
export function cardField(card: Card, field: string, billing?: Address): string | null {
  const mm = String(card.expMonth).padStart(2, "0");
  const yy = String(card.expYear).slice(-2);
  switch (field) {
    case "number":
      return card.number;
    case "exp":
      return `${mm}/${yy}`;
    case "expMonth":
      return mm;
    case "expYear":
      return String(card.expYear);
    case "expYY":
      return yy;
    case "cvc":
      return card.cvc;
    case "name":
      return card.holder;
    case "postal":
      return card.postal ?? billing?.postal ?? null;
    default:
      return addressField(billing, field);
  }
}

/** `card.number` → default card, `number`; `card@debit.cvc` → card `debit`, `cvc`. Null: not a card secret. */
export function cardSecret(name: string): { label: string | null; field: string } | null {
  const m = /^card(?:@([a-z0-9-]+))?\.([A-Za-z][A-Za-z0-9]*)$/.exec(name);
  return m ? { label: m[1] ?? null, field: m[2] as string } : null;
}

/** A host is `h` or under it. */
const under = (host: string, h: string) => host === h || host.endsWith(`.${h}`);

export interface CardPolicy {
  /** Hosts a debit card may be used on at all (banking, government); empty = never. */
  debitHosts: string[];
}

/**
 * Which card pays on `host`. Named: that card, if its kind is allowed here.
 * Default: a credit card; debit is never picked by default.
 * `subscription`: the page reads as recurring — never debit.
 */
export async function pickCard(
  wallet: Wallet,
  o: { host: string; label: string | null; subscription: boolean; policy: CardPolicy },
): Promise<Card> {
  const cards = await wallet.list();
  const card = o.label
    ? cards.find((c) => c.label === o.label)
    : cards.find((c) => c.kind === "credit");
  if (!card)
    throw new Error(
      o.label
        ? `no card "${o.label}" in the wallet (autobrowse wallet list)`
        : "no credit card in the wallet (autobrowse wallet add <label> --kind credit)",
    );
  if (card.kind === "debit") {
    if (o.subscription)
      throw new Error(
        `${describeCard(card)} is debit: never for a subscription; use a credit card`,
      );
    if (!o.policy.debitHosts.some((h) => under(o.host, h)))
      throw new Error(
        `${describeCard(card)} is debit: ${o.host} is not in WALLET_DEBIT_HOSTS (banking and strict sites only)`,
      );
  }
  return card;
}

/** Words on a checkout that mean the charge repeats. */
export const RECURRING =
  /\b(subscri(be|ption)|per (month|year)|\/ ?(mo|month|yr|year)\b|monthly|annually|yearly|recurring|renews?|auto-?renew|billed every)\b/i;
