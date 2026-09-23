/**
 * The browser half of `aws login --remote`: the CLI prints an authorize
 * URL and waits for a verification code that the signed-in console shows.
 * Mapped 2026-09-22 in explore: the authorize URL lands on "Continue with
 * an active session" with one card per console session (no button role:
 * the card's click handler sits on an ancestor div; since 2026-09-23 a card
 * shows only the user name, no account id); the confirmation page
 * renders the code in a Cloudscape code view whose text is elided, so the
 * "Copy verification code" button is the honest source, read through a
 * clipboard shim. The code never leaves the process: the chore pipes it
 * into the CLI's stdin.
 */
import { defineFlow } from "../flow.js";

export interface AwsCliLoginInput {
  /** The URL `aws login --remote` printed. */
  url: string;
  /** The IAM user (or root email) whose session card to pick; the first card when absent. */
  user?: string;
}

// The in-page functions below run in the browser; this module compiles without the DOM lib.
interface El {
  childElementCount: number;
  textContent: string | null;
  parentElement: El | null;
  onclick: unknown;
  click(): void;
  getAttribute(name: string): string | null;
}
declare const document: { querySelectorAll(sel: string): Iterable<El> };
declare const navigator: { clipboard: { writeText(t: string): Promise<void> } };

const CARD_MS = 60_000;
const CODE_MS = 60_000;

export const awsCliLogin = defineFlow<AwsCliLoginInput, { code: string }>({
  site: "aws",
  name: "cli-login",
  async run(fp, { url, user }) {
    // The authorize URL is on the sign-in host: land on it on purpose, then sign in through the console if no session is active.
    await fp.open(url, { allowWall: true });
    const card = { text: user ?? "/./" } as const;
    if (!(await fp.has({ text: "Continue with an active session" }, CARD_MS))) {
      await fp.open("https://console.aws.amazon.com/");
      await fp.open(url, { allowWall: true });
      if (!(await fp.has({ text: "Continue with an active session" }, CARD_MS)))
        return fp.human(`no active console session offered at ${fp.url()}`);
    }
    if (user && !(await fp.has(card, 5_000)))
      return fp.human(`no session card for ${user} on ${fp.url()}`);
    await fp.page.evaluate((who: string | null) => {
      const leaves = [...document.querySelectorAll("div, span")].filter(
        (e) => e.childElementCount === 0 && e.textContent?.trim(),
      );
      // A card named its account id (2026-09-22); now (2026-09-23) just the user: the
      // first leaf that is not page chrome (React handlers are not `onclick`, so text decides).
      const leaf = who
        ? leaves.find((e) => e.textContent?.trim() === who)
        : (leaves.find((e) => /\b\d{4}-?\d{4}-?\d{4}\b/.test(e.textContent ?? "")) ??
          leaves.find(
            (e) =>
              !/^(english|feedback|privacy|terms)$|new session/i.test(e.textContent?.trim() ?? ""),
          ));
      if (!leaf)
        throw new Error(
          `no session card among: ${leaves
            .slice(0, 30)
            .map((e) => (e.textContent ?? "").trim().replace(/\d/g, "#").slice(0, 40))
            .join(" | ")}`,
        );
      let n: El | null = leaf;
      while (n && !n.onclick) n = n.parentElement;
      (n ?? leaf).click();
    }, user ?? null);
    const copy = { role: "button", name: "Copy verification code" } as const;
    if (!(await fp.has(copy, CODE_MS)))
      return fp.human(`no verification code shown at ${fp.url()}`);
    const code = await fp.page.evaluate(() => {
      let captured = "";
      navigator.clipboard.writeText = (t: string) => {
        captured = t;
        return Promise.resolve();
      };
      const button = [...document.querySelectorAll("button")].find((b) =>
        /copy verification code/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
      );
      if (!button) throw new Error("no copy button");
      button.click();
      return captured;
    });
    if (!code) return fp.human("the Copy button gave nothing");
    return { code };
  },
});
