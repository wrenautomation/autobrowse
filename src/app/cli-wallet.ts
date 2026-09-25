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
  cardFromFields,
  describeCard,
  parseCardLine,
  WALLET_SSM_PATH,
} from "../money/wallet.js";
import type { Settings } from "./config.js";
import { askSecret } from "./prompt.js";
import { walletFor } from "./services.js";

export function registerWalletCommands(program: Command, settings: Settings): void {
  const wallet = program
    .command("wallet")
    .description("William's cards: credit pays, debit only where WALLET_DEBIT_HOSTS allows");
  wallet
    .command("add <label>")
    .description("Store a card: hidden prompts, one field each (paste works)")
    .requiredOption("--kind <kind>", "credit or debit")
    .option(
      "--clipboard",
      "take `number mm/yy cvc [postal] [name]` from the clipboard instead; clears it",
    )
    .action(async (label: string, o: { kind: string; clipboard?: boolean }) => {
      if (o.kind !== "credit" && o.kind !== "debit")
        throw new Error(`--kind is credit or debit, not ${o.kind}`);
      let card: Card;
      if (o.clipboard) {
        const clip = readClipboard();
        card = parseCardLine(clip.text, { label, kind: o.kind });
        clip.clear();
      } else card = cardFromFields(await askCard(), { label, kind: o.kind });
      await (await walletFor(settings)).put(card);
      console.log(`stored ${describeCard(card)}; backed up to SSM ${WALLET_SSM_PATH}/${label}`);
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
