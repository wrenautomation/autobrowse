/**
 * `autobrowse wallet …`: William's cards. A card is typed or pasted into
 * hidden prompts, one field each (like an SSH key passphrase), or with
 * `--clipboard` taken from one line (`number mm/yy cvc [postal] [name]`)
 * that is emptied after. Nothing here prints more than brand, kind, last 4.
 */
import type { Command } from "commander";
import { readClipboard } from "../auth/ingest.js";
import {
  type Card,
  type CardFields,
  cardBrand,
  cardChecks,
  cardEnding,
  cardFromFields,
  defaultLabel,
  describeCard,
  parseCardLine,
  WALLET_SSM_PATH,
} from "../money/wallet.js";
import type { Settings } from "./config.js";
import { askSecret } from "./prompt.js";
import { profilesFor, walletFor } from "./services.js";

export function registerWalletCommands(program: Command, settings: Settings): void {
  const profile = program
    .command("profile")
    .description(
      "Who you are and where your cards bill: sealed beside the wallet, backed up to SSM",
    );
  profile
    .command("list")
    .description("Every profile, with the cards that bill to it")
    .action(async () => {
      const { describeProfile, ownerOf } = await import("../money/profile.js");
      const all = await (await profilesFor(settings)).list();
      const cards = await (await walletFor(settings)).list();
      if (!all.length) return console.log("no profiles (autobrowse profile set <id> --name …)");
      for (const p of all) {
        const own = cards.filter((c) => ownerOf(all, c.owner)?.id === p.id).map(cardEnding);
        console.log(`${describeProfile(p)}\n  cards: ${own.join("; ") || "none"}`);
      }
    });
  profile
    .command("set <id>")
    .description("Create or change a profile; only the options given change")
    .option("--name <name>")
    .option("--birthday <yyyy-mm-dd>")
    .option("--gender <g>")
    .option("--line1 <street>")
    .option("--line2 <unit>")
    .option("--city <city>")
    .option("--region <name>", "spelled out: Alberta")
    .option("--region-code <code>", "abbreviated: AB")
    .option("--postal <code>")
    .option("--country <cc>", "two letters: CA")
    .option("--email <address>", "where its cards' receipts and invoices go")
    .option("--phone <+number>", "where its cards' charges are texted")
    .action(async (id: string, o: Record<string, string | undefined>) => {
      const { describeProfile, profileSchema, addressSchema } = await import("../money/profile.js");
      const store = await profilesFor(settings);
      const was = (await store.list()).find((p) => p.id === id);
      const def = <T extends object>(x: T) =>
        Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as Partial<T>;
      const addr = def({
        line1: o.line1,
        line2: o.line2,
        city: o.city,
        region: o.region,
        regionCode: o.regionCode,
        postal: o.postal,
        country: o.country,
      });
      const next = profileSchema.parse({
        ...was,
        id,
        ...def({
          name: o.name ?? was?.name,
          birthday: o.birthday,
          gender: o.gender,
          email: o.email,
          phone: o.phone,
        }),
        ...(Object.keys(addr).length || was?.address
          ? { address: addressSchema.parse({ ...was?.address, ...addr }) }
          : {}),
      });
      await store.put(next);
      console.log(`saved ${describeProfile(next)}`);
    });

  const wallet = program
    .command("wallet")
    .description("William's cards: credit pays, debit only where WALLET_DEBIT_HOSTS allows");
  wallet
    .command("add [label]")
    .description(
      "Store a card: hidden prompts, one field each (paste works); label defaults to brand-last4",
    )
    .requiredOption("--kind <kind>", "credit or debit")
    .option(
      "--clipboard",
      "take `number mm/yy cvc [postal] [name]` from the clipboard instead; clears it",
    )
    .action(async (given: string | undefined, o: { kind: string; clipboard?: boolean }) => {
      if (o.kind !== "credit" && o.kind !== "debit")
        throw new Error(`--kind is credit or debit, not ${o.kind}`);
      let card: Card;
      if (o.clipboard) {
        const clip = readClipboard();
        card = parseCardLine(clip.text, { label: given ?? "pending", kind: o.kind });
        clip.clear();
      } else {
        const f = await askCard();
        card = cardFromFields(f, { label: given ?? "pending", kind: o.kind });
      }
      if (!given) card = { ...card, label: defaultLabel(card.number) };
      const { replaces } = await (await walletFor(settings)).put(card);
      console.log(
        `stored ${describeCard(card)}${replaces ? ` (was ${replaces})` : ""}; backed up to SSM ${WALLET_SSM_PATH}/${card.label}`,
      );
    });
  wallet
    .command("list")
    .description("Brand, kind, last 4 and expiry of each card")
    .action(async () => {
      const cards = await (await walletFor(settings)).list();
      console.log(cards.length ? cards.map(describeCard).join("\n") : "the wallet is empty");
    });
  wallet
    .command("remove <label>")
    .description("Drop a card here and from the SSM backup")
    .action(async (label: string) => {
      const had = await (await walletFor(settings)).remove(label);
      console.log(had ? `removed ${label}` : `no card ${label} here; its backup is gone too`);
    });
  wallet
    .command("backup")
    .description(`Write every card to SSM ${WALLET_SSM_PATH} again (after a backup failed)`)
    .action(async () => {
      const labels = await (await walletFor(settings)).backup();
      console.log(labels.length ? `backed up ${labels.join(", ")}` : "the wallet is empty");
    });
  wallet
    .command("own <label> <profile>")
    .description(
      "Say which profile a card bills to (its address fills a checkout's billing fields)",
    )
    .action(async (label: string, profile: string) => {
      const w = await walletFor(settings);
      const card = await w.get(label);
      if (!card) throw new Error(`no card ${label}`);
      await w.put({ ...card, owner: profile });
      console.log(`${label} bills to ${profile}`);
    });
  wallet
    .command("tell <label>")
    .description(
      "Where this card's receipts and charge texts go; unset, the owner profile's, else this machine's",
    )
    .option("--email <address>")
    .option("--phone <+number>")
    .action(async (label: string, o: { email?: string; phone?: string }) => {
      const { cardSchema } = await import("../money/wallet.js");
      const { phoneEnding } = await import("../money/profile.js");
      const w = await walletFor(settings);
      const card = await w.get(label);
      if (!card) throw new Error(`no card ${label}`);
      const next = cardSchema.parse({ ...card, ...o });
      await w.put(next);
      console.log(
        `${label}: receipts ${next.email ?? "(owner's)"}, texts ${next.phone ? phoneEnding(next.phone) : "(owner's)"}`,
      );
    });
  wallet
    .command("history <label>")
    .description("Every version the SSM backup kept of a label: brand, kind, when")
    .action(async (label: string) => {
      const rows = await (await walletFor(settings)).history(label);
      console.log(rows.map((r) => `${r.version}  ${r.about}  ${r.at}`).join("\n") || "no history");
    });
  wallet
    .command("recover <label> <version>")
    .description(
      "Bring back an earlier version of a label (see history) under its brand-last4 label",
    )
    .option("--as <label>", "a label of your own")
    .action(async (label: string, version: string, o: { as?: string }) => {
      const card = await (await walletFor(settings)).recover(label, Number(version), o.as);
      console.log(`recovered ${describeCard(card)}`);
    });
  wallet
    .command("restore")
    .description(`Bring every card back from SSM ${WALLET_SSM_PATH} (a new Mac, a lost file)`)
    .action(async () => {
      const labels = await (await walletFor(settings)).restore();
      console.log(labels.length ? `restored ${labels.join(", ")}` : "no cards in the backup");
    });
}

/** Each field hidden, checked as it is entered; a wrong one is asked again (Ctrl-C quits). */
async function askCard(): Promise<CardFields> {
  const ask = async (q: string, check: (v: string) => unknown) => {
    for (;;) {
      const v = await askSecret(q);
      try {
        const said = check(v);
        if (typeof said === "string") process.stderr.write(`  ${said}\n`);
        return v;
      } catch (err) {
        process.stderr.write(`  ${(err as Error).message}; again\n`);
      }
    }
  };
  const number = await ask("card number (hidden): ", (v) => {
    const n = cardChecks.number(v);
    return `ok: ${cardBrand(n)} ending ${n.slice(-4)}`;
  });
  const exp = await ask("expiry mm/yy (hidden): ", (v) => void cardChecks.exp(v));
  const cvc = await ask("CVC (hidden): ", (v) => void cardChecks.cvc(v));
  const postal = await ask(
    "postal code (hidden, Enter to skip): ",
    (v) => void cardChecks.postal(v),
  );
  const name = await ask("name on card (hidden, Enter for William Jin): ", () => null);
  return { number, exp, cvc, ...(postal ? { postal } : {}), ...(name ? { name } : {}) };
}
