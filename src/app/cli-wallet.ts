/**
 * `autobrowse wallet …`: William's cards. A card arrives on the clipboard
 * (`number mm/yy cvc [postal] [name on card]`), which is emptied once it is
 * stored; nothing here prints more than brand, kind and last 4.
 */
import type { Command } from "commander";
import { readClipboard } from "../auth/ingest.js";
import { describeCard, parseCardLine, WALLET_SSM_PATH } from "../money/wallet.js";
import type { Settings } from "./config.js";
import { walletFor } from "./services.js";

export function registerWalletCommands(program: Command, settings: Settings): void {
  const wallet = program
    .command("wallet")
    .description("William's cards: credit pays, debit only where WALLET_DEBIT_HOSTS allows");
  wallet
    .command("add <label>")
    .description("Store the card on the clipboard as `number mm/yy cvc [postal] [name]`; clears it")
    .requiredOption("--kind <kind>", "credit or debit")
    .action(async (label: string, o: { kind: string }) => {
      if (o.kind !== "credit" && o.kind !== "debit")
        throw new Error(`--kind is credit or debit, not ${o.kind}`);
      const clip = readClipboard();
      const card = parseCardLine(clip.text, { label, kind: o.kind });
      clip.clear();
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
