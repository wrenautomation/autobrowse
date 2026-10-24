/** The operator's money and papers: wallet, billing profiles, files, the cards explore may place, charges. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { SSMClient } from "@aws-sdk/client-ssm";
import { aesGcmCipher, chainedFile, keychainKey, tailJson } from "credvault";
import { registrable } from "../auth/guard.js";
import { WALLET_KEYCHAIN } from "../auth/keep.js";
import { type Channel, linqChannel, phoneChannel } from "../channels/index.js";
import { httpClient } from "../clients/http.js";
import { phoneReader } from "../devices/phone.js";
import type { ExploreOptions } from "../explore/server.js";
import { expandHome } from "../google/auth.js";
import type { GmailUserClient } from "../google/gmail.js";
import { bankCodeReader } from "../money/bank-code.js";
import { type Charge, type ChargeRow, reportCharge } from "../money/charges.js";
import { isDefaultOwner } from "../owner.js";
import type { Settings } from "./config.js";
import { awsFor } from "./owner.js";
import { lazy } from "./services-kit.js";
import { spendGrantsFor } from "./services-reach.js";
import { linqFor, phoneFor } from "./services-signin.js";
import { credentialsFor, ledgerPath } from "./services-state.js";

/** Cards and the person's details are the operator's: an owner has neither (designs/2026-09-30-owner-keys.md). */
function operatorOnly(settings: Settings, what: string): void {
  if (!isDefaultOwner(settings.owner))
    throw new Error(`owner ${settings.owner}: ${what} are the operator's; an owner has none`);
}

/**
 * The wallet: the sealed file here (its own keychain item, so a credential
 * read never opens it), backed up to SSM /wallet on every change. macOS only:
 * a machine without the keychain has no cards.
 */
export async function walletFor(
  settings: Settings,
  ssm: SSMClient = lazy(() => new SSMClient(awsFor(settings))),
) {
  operatorOnly(settings, "cards");
  if (process.platform !== "darwin") throw new Error("the wallet lives on the Mac only");
  const { backedUpWallet, fileWallet, ssmWallet } = await import("../money/wallet.js");
  return backedUpWallet(
    fileWallet(expandHome(settings.walletFile), aesGcmCipher(keychainKey(WALLET_KEYCHAIN))),
    ssmWallet(ssm),
  );
}

/** The person's own details, sealed beside the wallet (same keychain item), backed up to SSM /wallet/profiles. */
export async function profilesFor(
  settings: Settings,
  ssm: SSMClient = lazy(() => new SSMClient(awsFor(settings))),
) {
  operatorOnly(settings, "profiles");
  if (process.platform !== "darwin") throw new Error("profiles live on the Mac only");
  const { backedUpProfiles, fileProfiles, ssmProfiles } = await import("../money/profile.js");
  return backedUpProfiles(
    fileProfiles(
      join(dirname(expandHome(settings.walletFile)), "profiles.sealed"),
      aesGcmCipher(keychainKey(WALLET_KEYCHAIN)),
    ),
    ssmProfiles(ssm),
  );
}

/**
 * Files for forms (`autobrowse files`): papers and docs, sealed under the wallet's key on the
 * Mac, backed up to PAPERS_BUCKET when set (deploy/terraform papers.tf; only William's AWS user
 * reaches it). `migrating`: the old papers dir may still be there (`files migrate` reads it).
 */
export async function filesFor(settings: Settings, o: { migrating?: boolean } = {}) {
  operatorOnly(settings, "files");
  if (process.platform !== "darwin") throw new Error("files live on the Mac only");
  const dir = expandHome(settings.filesDir);
  if (!o.migrating && existsSync(join(oldPapersDir(dir), "index.sealed")))
    throw new Error(
      `papers not moved yet: autobrowse files migrate (${oldPapersDir(dir)} → ${dir})`,
    );
  const { backedUpFiles, bucketFiles, fileStore } = await import("../files/store.js");
  const local = fileStore(dir, aesGcmCipher(keychainKey(WALLET_KEYCHAIN)));
  const bucket = settings.filesBucket;
  if (!bucket) {
    const none = () => {
      throw new Error("no PAPERS_BUCKET: these files have no backup (deploy/terraform papers.tf)");
    };
    return { ...local, backedUp: false, restore: none, backup: none };
  }
  const { s3FileBucket } = await import("../shots/s3.js");
  return {
    ...backedUpFiles(local, bucketFiles(s3FileBucket({ bucket, aws: awsFor(settings) }))),
    backedUp: true,
  };
}

/** Where `autobrowse papers` kept them: `papers/` beside the files dir. */
export const oldPapersDir = (filesDir: string): string => join(dirname(filesDir), "papers");

/** Explore's files for `upload{files:["file:<name>"]}` and `read_file`: on the Mac only, like the wallet. */
export function filesForExplore(settings: Settings): ExploreOptions["files"] {
  if (process.platform !== "darwin" || !isDefaultOwner(settings.owner)) return undefined;
  const store = () => filesFor(settings);
  return {
    list: async () => (await store()).list(),
    get: async (name) => (await store()).get(name),
    sets: async () => (await store()).sets(),
  };
}

/** Explore's card picker: the Mac's wallet under WALLET_DEBIT_HOSTS; elsewhere none (card places are refused). */
export function cardsFor(settings: Settings): ExploreOptions["cards"] {
  if (process.platform !== "darwin" || !isDefaultOwner(settings.owner)) return undefined;
  return async ({ host, label, subscription }) => {
    const { pickCard } = await import("../money/wallet.js");
    const { contactsOf, profileOf } = await import("../money/profile.js");
    const card = await pickCard(await walletFor(settings), {
      host,
      label,
      subscription,
      policy: { debitHosts: settings.walletDebitHosts },
    });
    // The billing address is the profile's: a checkout's address fields come from the profile.
    const profile = profileOf(await (await profilesFor(settings)).list(), card.profile);
    return {
      ...card,
      ...(profile?.address ? { billing: profile.address } : {}),
      tell: contactsOf(card, profile),
      ...(profile?.taxId ? { taxId: profile.taxId } : {}),
    };
  };
}

/** The bank's confirmation text for `place{secret:"card.code"}`: the paired phone's Messages, on the Mac only, like the wallet. */
export function cardCodeFor(settings: Settings): ExploreOptions["cardCode"] {
  if (process.platform !== "darwin" || !isDefaultOwner(settings.owner)) return undefined;
  const phone = phoneFor(settings);
  return phone ? bankCodeReader(phoneReader(phone), phone.number) : undefined;
}

/** Whether a yes given ahead (`spend --grant`) is live for a site: it stands for the payment yes. */
export function grantedAheadFor(settings: Settings): NonNullable<ExploreOptions["grantedAhead"]> {
  const grants = spendGrantsFor(settings);
  return (site) => grants.live(site, new Date()) !== null;
}

/** The profiles for `place{secret:"profile.<field>"}`: on the Mac only, like the wallet. */
export function profilesForPlace(settings: Settings): ExploreOptions["profiles"] {
  if (process.platform !== "darwin" || !isDefaultOwner(settings.owner)) return undefined;
  return async (id) => {
    const { profileOf } = await import("../money/profile.js");
    return profileOf(await (await profilesFor(settings)).list(), id ?? undefined);
  };
}

/** Which card each host was given (brand, kind, last 4 only): a chained ledger, read from its tail. */
export function cardsOnFileFor(settings: Settings): NonNullable<ExploreOptions["cardsOnFile"]> {
  type Row = { at: string; site: string; host: string; card: string };
  const path = ledgerPath(settings, "cards-on-file");
  const ledger = chainedFile<Row>(path);
  return {
    placed: (row) => ledger.append(row),
    async on(host) {
      const rows = await tailJson<Row>(path, 500);
      return rows.findLast((r) => r.host === host)?.card ?? null;
    },
  };
}

/**
 * How a charge is told: a text over the phone channels, an email with the
 * receipt, and a line in charges.jsonl. To the card's own contacts (card,
 * then its owner's profile), else RECEIPTS_TO (else NOTIFY_TO) and this
 * machine's phone.
 */
export function chargesFor(
  settings: Settings,
  gmail: GmailUserClient,
  http = httpClient(),
): NonNullable<ExploreOptions["charges"]> {
  const from = settings.notifyFrom ?? settings.googleAdminUser;
  const receiptsTo = settings.receiptsTo ?? settings.notifyTo;
  const phone = phoneFor(settings);
  const linq = linqFor(settings, http);
  const textsTo = (number?: string) =>
    [
      phone && phoneChannel(number ? { ...phone, number } : phone),
      linq && linqChannel(number ? { ...linq, to: number } : linq),
    ].filter((c): c is Channel => Boolean(c?.note));
  const ledger = chainedFile<ChargeRow>(ledgerPath(settings, "charges"));
  // The merchant's invoice goes to the account's inbox; one that is already the receipts inbox is not read.
  const invoice = async (c: Charge, since: Date) => {
    const cred = await credentialsFor(settings)
      .get(c.site)
      .catch(() => null);
    const inbox = [cred?.username, cred?.codesInbox].find((a) => a?.includes("@"));
    if (!inbox || inbox.toLowerCase() === receiptsTo?.toLowerCase()) return null;
    const domain = registrable(c.host);
    const found = await gmail.whole(
      inbox,
      `after:${Math.floor(since.getTime() / 1000)} {from:${domain} subject:receipt subject:invoice subject:order subject:payment subject:purchase subject:subscription}`,
    );
    return found.find((m) => m.from.toLowerCase().includes(domain)) ?? found[0] ?? null;
  };
  return async (c, r, tell) => {
    const to = tell?.email ?? receiptsTo;
    const texts = textsTo(tell?.phone);
    return (
      await reportCharge(
        {
          ledger,
          invoice,
          ...(texts.length
            ? { text: async (line) => void (await Promise.any(texts.map((t) => t.note?.(line)))) }
            : {}),
          ...(from && to ? { email: (m) => gmail.send({ from, to, ...m }) } : {}),
        },
        c,
        r,
      )
    ).told;
  };
}
