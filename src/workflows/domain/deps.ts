/** What the domain workflow needs from the world. Built once in `app/services.ts`; faked in tests. */
import type { CredentialStore } from "credvault";
import type { FlowRunner } from "../../browser/flow.js";
import type { CloudflareClient } from "../../clients/cloudflare.js";
import type { GmailUserClient } from "../../clients/gmail.js";
import type { GoogleAdminClient } from "../../clients/google-admin.js";
import type { InstantlyClient } from "../../clients/instantly.js";
import type { RosterStore } from "../../clients/roster.js";
import type { WrenClient } from "../../clients/wren.js";

export interface DomainDeps {
  cloudflare: CloudflareClient;
  google: GoogleAdminClient;
  gmail: GmailUserClient;
  roster: RosterStore;
  /** Wren's own orchestrator; null for any other owner, whose roster is written and left there. */
  wren: WrenClient | null;
  browser: FlowRunner;
  /**
   * Where each inbox's sign-in lives, as `google@<email>`: the password,
   * then the authenticator seed. The runner signs a `google@<email>`
   * profile in from it, so no inbox ever needs a person to log in.
   */
  credentials: CredentialStore;
  /** A URL's bytes in a local file, for a browser upload; the file's path. */
  download: (url: string) => Promise<string>;
  /** Instantly with its API key, or null while no key is set. */
  instantly: () => Promise<InstantlyClient | null>;
  dmarcRua: string | null;
  /** How long to keep asking Google to see a TXT before giving the human the wheel. */
  dnsWaitMs?: number;
  /** Between asks of an API inside one step (Instantly's OAuth session); 5 s when absent. */
  pollMs?: number;
}
