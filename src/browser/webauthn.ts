/**
 * Passkeys, on our terms. A page that calls WebAuthn (Google's
 * "Complete sign-in using your passkey") makes Chrome raise a native
 * sheet the DOM cannot see and a click cannot dismiss; the flow hangs.
 * A virtual authenticator over CDP answers instead: with no credential it
 * fails the request at once and the page offers "Try another way". With
 * a credential (enrolled by us, stored sealed) it *is* the passkey: the
 * strongest second factor, no codes, no phone. That enrollment is the
 * next step; this file is its seam.
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

/** Attach a virtual authenticator to every page in the context, present and future. Chromium only; elsewhere a no-op. */
export function virtualAuthenticator(context: BrowserContext): void {
  const attach = async (page: Page): Promise<void> => {
    let cdp: CDPSession;
    try {
      cdp = await context.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", { options: OPTIONS });
    } catch {
      // Not Chromium, or the page went away: the native path stays.
    }
  };
  for (const page of context.pages()) void attach(page);
  context.on("page", (page) => void attach(page));
}
