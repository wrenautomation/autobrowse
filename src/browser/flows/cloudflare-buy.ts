/**
 * Buy a domain at Cloudflare Registrar. There is no purchase API, so this
 * is the dashboard flow: search → the exact match → checkout. Selectors are
 * visible labels, so a redesign breaks loudly (a timeout with a trace),
 * never silently. Approval happens before this step ever runs, and the
 * step proves the purchase through the Registrar API afterwards.
 *
 * UNVERIFIED against a real purchase until the first run.
 */
import { defineFlow } from "../flow.js";

export interface BuyInput {
  domain: string;
}

export interface BuyResult {
  /** What the checkout page showed; kept on the run for the record. */
  priceText: string | null;
}

const PRICE = /\$\s?\d+(\.\d{2})?/;

export const cloudflareBuy = defineFlow<BuyInput, BuyResult>({
  site: "cloudflare",
  name: "buy",
  async run(fp, { domain }) {
    const { page } = fp;
    // `?to=` deep-links into the current account without knowing its id.
    await fp.open("https://dash.cloudflare.com/?to=/:account/domains/register");

    const search = page
      .getByRole("searchbox")
      .or(page.getByPlaceholder(/search/i))
      .first();
    await search.fill(domain);
    await search.press("Enter");

    // The exact-match row carries the domain and a Purchase button.
    const purchase = page.getByRole("button", { name: /purchase|add to cart/i });
    const row = page
      .locator("tr, li, div")
      .filter({ hasText: domain })
      .filter({ has: purchase })
      .first();
    if (
      !(await row.waitFor({ timeout: 30_000 }).then(
        () => true,
        () => false,
      ))
    )
      fp.human(`no purchasable row for ${domain}`);
    await row.getByRole("button", { name: /purchase|add to cart/i }).click();

    const checkout = page.getByRole("button", { name: /complete purchase|confirm|pay/i }).first();
    if (
      !(await checkout.waitFor({ timeout: 30_000 }).then(
        () => true,
        () => false,
      ))
    )
      fp.human("checkout button not found");
    const priceText = (await page.locator("body").innerText()).match(PRICE)?.[0] ?? null;
    await checkout.click();

    const confirmed = page.getByText(
      /registration (is )?(complete|successful)|successfully registered|your domain is registered/i,
    );
    if (
      !(await confirmed.waitFor({ timeout: 90_000 }).then(
        () => true,
        () => false,
      ))
    )
      fp.human("no confirmation after checkout");
    return { priceText };
  },
});
