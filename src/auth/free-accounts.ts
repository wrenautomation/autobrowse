/**
 * Free accounts any sending inbox can hold, so the inbox gets the ordinary
 * mail and use a real person's does: one list, run per inbox by
 * `autobrowse inbox-accounts <inbox>`. Each entry is made by email (the
 * signup agent, codes read from the inbox) or through Google (the inbox's
 * own Google login presses "Continue with Google"). The inbox-activity
 * workflow opens the verify mail of every sender here.
 */
import type { CredentialStore } from "credvault";

export interface FreeAccount {
  site: string;
  /**
   * Signup page for `email`. For `google`, a page that needs a sign-in and
   * sends a stranger to the login: Todoist's /auth/login shows its form even
   * signed in, so the check after the round trip never passed (2026-10-02).
   */
  url: string;
  via: "email" | "google";
  /** The host its mail comes from, for inbox-activity's verify links. */
  sender: string;
}

/** Tried on william@wren-automation.net 2026-10-02: each made or signed in there. */
export const FREE_ACCOUNTS: readonly FreeAccount[] = [
  {
    site: "todoist",
    url: "https://app.todoist.com/auth/signup",
    via: "email",
    sender: "todoist.com",
  },
  { site: "airtable", url: "https://airtable.com/signup", via: "email", sender: "airtable.com" },
  { site: "trello", url: "https://trello.com/signup", via: "email", sender: "atlassian.com" },
  { site: "notion", url: "https://www.notion.so/login", via: "google", sender: "notion.so" },
  {
    site: "todoist",
    url: "https://app.todoist.com/app/today",
    via: "google",
    sender: "todoist.com",
  },
];

export type FreeAccountStep =
  | { kind: "made"; key: string }
  | { kind: "signup"; site: string; url: string }
  | { kind: "google"; key: string; url: string; stored: boolean };

/**
 * What `inbox` still needs on `a`: nothing (made, or a Google sign-in on
 * file), an email signup, or a Google sign-in under `site@<label>-google`.
 */
export async function freeAccountStep(
  store: CredentialStore,
  a: FreeAccount,
  inbox: string,
): Promise<FreeAccountStep> {
  const who = inbox.toLowerCase();
  const names = (await store.list()).filter((n) => n === a.site || n.startsWith(`${a.site}@`));
  const held = await Promise.all(names.map(async (n) => [n, await store.get(n)] as const));
  const mine = held.filter(([, c]) => c?.username.toLowerCase() === who);
  if (a.via === "email") {
    const made = mine.find(([, c]) => c?.madeAt && c.password);
    return made ? { kind: "made", key: made[0] } : { kind: "signup", site: a.site, url: a.url };
  }
  // One account with both ways in (`creds same`) counts for both.
  const google = mine.find(([, c]) => c?.via === "google");
  if (google) return { kind: "google", key: google[0], url: a.url, stored: true };
  const [local = "", domain = ""] = who.split("@");
  const label = `${local}-${domain.split(".")[0] ?? ""}`.replace(/[^a-z0-9-]+/g, "");
  return { kind: "google", key: `${a.site}@${label}-google`, url: a.url, stored: false };
}

/** The senders inbox-activity watches: every free account's mail host. */
export const FREE_ACCOUNT_SENDERS = [...new Set(FREE_ACCOUNTS.map((a) => a.sender))];
