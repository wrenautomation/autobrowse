/**
 * Passkeys, on our terms. A page that calls WebAuthn (Google's
 * "Complete sign-in using your passkey") makes Chrome raise a native
 * sheet the DOM cannot see and a click cannot dismiss; the flow hangs.
 * A virtual authenticator over CDP answers instead: with no credential it
 * fails the request at once and the page offers "Try another way". With
 * a credential (enrolled by us, stored sealed) it *is* the passkey: the
 * strongest second factor, no codes, no phone. `Passkeys` is the handle:
 * load stored ones at session start, export new ones after an enrollment.
 */
import type { BrowserContext, CDPSession, Page } from "playwright";

const OPTIONS = {
  protocol: "ctap2",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
} as const;

/** One passkey as the authenticator holds it: what CDP exports, base64 fields as given. */
export interface PasskeyRecord {
  rpId: string;
  credentialId: string;
  privateKey: string;
  userHandle?: string | undefined;
  signCount: number;
  isResidentCredential: boolean;
}

export interface Passkeys {
  /** Every credential the authenticators hold now, across pages (deduped by id). */
  export(): Promise<PasskeyRecord[]>;
}

interface Attached {
  cdp: CDPSession;
  authenticatorId: string;
}

/**
 * Attach a virtual authenticator to every page in the context, present
 * and future, loaded with `stored`. Chromium only; elsewhere a no-op
 * handle that exports nothing.
 */
export function virtualAuthenticator(
  context: BrowserContext,
  stored: readonly PasskeyRecord[] = [],
): Passkeys {
  const attached = new Map<Page, Attached>();
  const attach = async (page: Page): Promise<void> => {
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: OPTIONS,
      });
      for (const c of stored) {
        const { userHandle, ...rest } = c;
        await cdp.send("WebAuthn.addCredential", {
          authenticatorId,
          credential: userHandle ? { ...rest, userHandle } : rest,
        });
      }
      attached.set(page, { cdp, authenticatorId });
      page.once("close", () => attached.delete(page));
    } catch {
      // Not Chromium, or the page went away: the native path stays.
    }
  };
  for (const page of context.pages()) void attach(page);
  context.on("page", (page) => void attach(page));
  return {
    async export() {
      const byId = new Map<string, PasskeyRecord>();
      for (const { cdp, authenticatorId } of attached.values()) {
        const { credentials } = await cdp
          .send("WebAuthn.getCredentials", { authenticatorId })
          .catch(() => ({ credentials: [] as PasskeyRecord[] }));
        for (const c of credentials)
          byId.set(c.credentialId, {
            rpId: c.rpId ?? "",
            credentialId: c.credentialId,
            privateKey: c.privateKey,
            ...(c.userHandle ? { userHandle: c.userHandle } : {}),
            signCount: c.signCount,
            isResidentCredential: c.isResidentCredential,
          });
      }
      return [...byId.values()];
    },
  };
}
