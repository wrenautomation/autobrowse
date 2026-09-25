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
 *
 * A stale sign-in cookie makes AWS answer "400 Bad Request … clear your
 * cookies" (2026-09-25, twice). Then the AWS cookies (this profile only) are
 * cleared, the console signs in fresh, and the card is tried once more.
 */
import { defineFlow, type FlowPage } from "../flow.js";

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
const COPY = { role: "button", name: "Copy verification code" } as const;
const BAD_REQUEST = { role: "heading", name: "Bad Request" } as const;
const AWS_COOKIES = /(^|\.)aws\.amazon\.com$/;

export const awsCliLogin = defineFlow<AwsCliLoginInput, { code: string }>({
  site: "aws",
  name: "cli-login",
  async run(fp, { url, user }) {
    if ((await continueSession(fp, url, user)) === "stale") {
      await fp.page.context().clearCookies({ domain: AWS_COOKIES });
      if ((await continueSession(fp, url, user)) === "stale")
        return fp.human(`AWS still says Bad Request at ${fp.url()} after fresh cookies`);
    }
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

/** Pick the session card on the authorize page; "code" when the code page shows, "stale" on AWS's 400. */
async function continueSession(
  fp: FlowPage,
  url: string,
  user: string | undefined,
): Promise<"code" | "stale"> {
  // The authorize URL is on the sign-in host: land on it on purpose, then sign in through the console if no session is active.
  await fp.open(url, { allowWall: true });
  if (await fp.has(BAD_REQUEST, 2_000)) return "stale";
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
  // The code page, or AWS's 400 for a stale cookie: whichever shows first.
  const at = Date.now();
  while (Date.now() - at < CODE_MS) {
    if (await fp.has(COPY, 1_000)) return "code";
    if (await fp.has(BAD_REQUEST)) return "stale";
  }
  return fp.human(`no verification code shown at ${fp.url()}`);
}
