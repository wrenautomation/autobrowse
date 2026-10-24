/** Reaching people and Google: Workspace tokens and admin, Gmail, the approver and spend policy, the channels a person answers on. */
import { dirname, join } from "node:path";
import {
  type Channel,
  emailChannel,
  forwardChannel,
  linqChannel,
  phoneChannel,
  webhookChannel,
} from "../channels/index.js";
import { type GoogleAdminClient, googleAdmin } from "../clients/google-admin.js";
import { fetchOf, type HttpClient, httpClient } from "../clients/http.js";
import { phoneReader } from "../devices/phone.js";
import { askOverChannel } from "../gates/ask.js";
import type { Approver } from "../gates/payment.js";
import {
  fileGrants,
  fileSpendLedger,
  type Grants,
  policedApprover,
  type SpendLedger,
  type SpendPolicy,
} from "../gates/spend.js";
import {
  delegatedScopes,
  expandHome,
  loadServiceAccountKey,
  SCOPES,
  serviceAccountToken,
  type TokenSupplier,
} from "../google/auth.js";
import { type GmailUserClient, gmailClient } from "../google/gmail.js";
import { accessTokens, accountEnv, gmailOAuth } from "../sites/index.js";
import type { Settings } from "./config.js";
import { required } from "./services-kit.js";
import { linqFor, phoneFor } from "./services-signin.js";
import { ledgerPath } from "./services-state.js";

/**
 * Google, one token supplier per (subject, scopes), each caching its bearer:
 * an account that consented (`site setup gmail consent --account <it>`,
 * `GMAIL_REFRESH_TOKEN__<IT>`) is acted as through its own refresh token
 * for Gmail scopes; any other scope (the admin API), and every other subject,
 * through the service account (domain-wide delegation, our Workspace only).
 */
export function googleTokens(
  settings: Settings,
  env: (name: string) => string | undefined = (n) => process.env[n],
  http = httpClient(),
) {
  const tokens = new Map<string, TokenSupplier>();
  let key: ReturnType<typeof loadServiceAccountKey> | null = null;
  const consented = accessTokens(http, env);
  const tokenFor = (subject: string, scopes: readonly string[]): TokenSupplier => {
    const k = `${subject} ${scopes.join(" ")}`;
    let t = tokens.get(k);
    // The consent grants Gmail only: an admin scope on the same account (the admin user) delegates.
    const gmailOnly = scopes.every((s) => s.startsWith("https://www.googleapis.com/auth/gmail."));
    if (!t && gmailOnly && env(accountEnv(gmailOAuth.refreshToken, subject))) {
      t = async () => {
        const token = await consented(gmailOAuth, subject);
        if (!token) throw new Error(`no Gmail token for ${subject}`);
        return token;
      };
      tokens.set(k, t);
    }
    if (!t) {
      key ??= loadServiceAccountKey(
        required(settings.googleServiceAccount, "GOOGLE_SERVICE_ACCOUNT"),
      );
      t = serviceAccountToken(key, { scopes: delegatedScopes(scopes), subject });
      tokens.set(k, t);
    }
    return t;
  };
  return tokenFor;
}

/** The Workspace admin API as GOOGLE_ADMIN_USER: domains, users, their names and passwords. */
export function googleAdminFor(
  settings: Settings,
  http = httpClient(),
  scopes: readonly string[] = [
    SCOPES.directoryDomain,
    SCOPES.directoryUser,
    SCOPES.siteVerification,
  ],
): GoogleAdminClient {
  return googleAdmin({
    token: googleTokens(
      settings,
      undefined,
      http,
    )(required(settings.googleAdminUser, "GOOGLE_ADMIN_USER"), scopes),
    http,
  });
}

export function gmailFor(settings: Settings, http = httpClient()): GmailUserClient {
  return gmailClient({
    tokenFor: googleTokens(settings),
    scopes: { settings: SCOPES.gmailSettings, send: SCOPES.gmailSend, read: SCOPES.gmailRead },
    fetch: fetchOf(http),
  });
}

/** The ways to reach people and systems, from settings: email, the paired phone, a webhook. */
/**
 * Who answers a payment gate: the first channel the person both hears and
 * can reply on (phone → Linq → email); null when there is none, and then
 * the session refuses the act rather than guessing.
 */
export function approverFor(
  settings: Settings,
  gmail: GmailUserClient,
  http = httpClient(),
): Approver | null {
  const person = personApprover(settings, gmail, http);
  if (!person) return null;
  return policedApprover(person, {
    policy: spendPolicyFor(settings),
    ledger: spendLedgerFor(settings),
    grants: spendGrantsFor(settings),
  });
}

/** Yeses the person gave ahead (`spend --grant`), beside the ledgers. */
export function spendGrantsFor(settings: Settings): Grants {
  return fileGrants(join(dirname(expandHome(settings.credentialsFile)), "spend-grants.json"));
}

/** What the gate decides alone (`SPEND_*`); default: nothing, the person answers every ask. */
export function spendPolicyFor(settings: Settings): SpendPolicy {
  return {
    allow: settings.spendAllow,
    autoYesUnder: settings.spendAutoYesUnder,
    dailyCap: settings.spendDailyCap,
    hardCap: settings.spendHardCap ?? null,
  };
}

/** Every gate decision, next to the credential file and the secret audit. */
export function spendLedgerFor(settings: Settings): SpendLedger {
  return fileSpendLedger(ledgerPath(settings, "spend"));
}

/** The channel a person answers on: phone, then Linq, then email. */
function personApprover(
  settings: Settings,
  gmail: GmailUserClient,
  http: HttpClient,
): Approver | null {
  const phone = phoneFor(settings);
  if (phone) {
    const ch = phoneChannel(phone);
    if (ch.note)
      return askOverChannel({
        note: ch.note.bind(ch),
        reader: phoneReader(phone),
        inbox: phone.number,
      });
  }
  const linq = linqFor(settings, http);
  if (linq) {
    const ch = linqChannel(linq);
    if (ch.note)
      return askOverChannel({
        note: ch.note.bind(ch),
        reader: linq.client.reader(),
        inbox: linq.to,
      });
  }
  const notifyFrom = settings.notifyFrom ?? settings.googleAdminUser;
  if (settings.notifyTo && notifyFrom) {
    const ch = emailChannel({ gmail, from: notifyFrom, to: settings.notifyTo });
    if (ch.note)
      return askOverChannel({ note: ch.note.bind(ch), reader: gmail, inbox: notifyFrom }); // replies land in the sender's inbox
  }
  return null;
}

/** FEED_HOSTS as a list; empty when unset. */
export const feedHostsOf = (settings: Settings): string[] =>
  (settings.feedHosts ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

export function channelsFor(
  settings: Settings,
  gmail: GmailUserClient,
  http = httpClient(),
): Channel[] {
  const list: Channel[] = [];
  const notifyFrom = settings.notifyFrom ?? settings.googleAdminUser;
  if (settings.notifyTo && notifyFrom)
    list.push(emailChannel({ gmail, from: notifyFrom, to: settings.notifyTo }));
  const phone = phoneFor(settings);
  if (phone) list.push(phoneChannel(phone));
  const linq = linqFor(settings, http);
  if (linq) list.push(linqChannel(linq));
  if (settings.webhookUrl)
    list.push(
      webhookChannel({
        url: settings.webhookUrl,
        http,
        ...(settings.webhookToken ? { token: settings.webhookToken } : {}),
      }),
    );
  if (feedHostsOf(settings).length > 0)
    list.push(
      forwardChannel({
        ...(settings.feedToken ? { token: settings.feedToken } : {}),
        log: (line) => console.warn(line),
      }),
    );
  return list;
}
