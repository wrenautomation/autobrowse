/** What the domain workflow needs from the world. Built once in `app/services.ts`; faked in tests. */
import type { FlowRunner } from "../../browser/flow.js";
import type { CloudflareClient } from "../../clients/cloudflare.js";
import type { GmailUserClient } from "../../clients/gmail.js";
import type { GoogleAdminClient } from "../../clients/google-admin.js";
import type { RosterStore } from "../../clients/roster.js";
import type { WrenClient } from "../../clients/wren.js";

export interface DomainDeps {
  cloudflare: CloudflareClient;
  google: GoogleAdminClient;
  gmail: GmailUserClient;
  roster: RosterStore;
  wren: WrenClient;
  browser: FlowRunner;
  /** A secret store for inbox passwords (SSM): `put(name, value)`. */
  secrets: { put: (name: string, value: string) => Promise<void> };
  dmarcRua: string | null;
  /** How long to keep asking Google to see a TXT before giving the human the wheel. */
  dnsWaitMs?: number;
}
