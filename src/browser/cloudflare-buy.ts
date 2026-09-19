/**
 * Buy a domain at Cloudflare Registrar. There is no purchase API, so this is
 * the dashboard flow: search → pick the exact match → checkout. Recorded
 * against the dashboard on 2026-09-19; selectors are the visible labels, so
 * a redesign breaks loudly (a timeout with a screenshot), never silently.
 *
 * UNVERIFIED against a real purchase until the first run. Approval happens
 * before this step ever runs.
 */
import { looksLikeWall, NeedsHuman, type Session } from "./session.js";

export interface PurchaseResult {
  domain: string;
  /** What the checkout page showed; kept on the run for the record. */
  priceText: string | null;
}

export async function cloudflareBuy(
  session: Session,
  accountId: string,
  domain: string,
): Promise<PurchaseResult> {
  const { page } = session;
  await page.goto(`https://dash.cloudflare.com/${accountId}/domains/register`, {
    waitUntil: "domcontentloaded",
  });
  const wall = await looksLikeWall(page);
  if (wall) throw new NeedsHuman(`cloudflare: ${wall}`, await session.screenshot("wall"));

  const search = page
    .getByRole("searchbox")
    .or(page.getByPlaceholder(/search/i))
    .first();
  await search.fill(domain);
  await search.press("Enter");

  // The exact-match row carries the domain and a Purchase button.
  const row = page
    .locator("tr, li, div")
    .filter({ hasText: domain })
    .filter({ has: page.getByRole("button", { name: /purchase|add to cart/i }) })
    .first();
  await row.waitFor({ timeout: 30_000 }).catch(async () => {
    throw new NeedsHuman(
      `cloudflare: no purchasable row for ${domain}`,
      await session.screenshot("no-row"),
    );
  });
  await row.getByRole("button", { name: /purchase|add to cart/i }).click();

  const checkout = page.getByRole("button", { name: /complete purchase|confirm|pay/i }).first();
  await checkout.waitFor({ timeout: 30_000 }).catch(async () => {
    throw new NeedsHuman(
      "cloudflare: checkout button not found",
      await session.screenshot("checkout"),
    );
  });
  const priceText = await page
    .locator("body")
    .innerText()
    .then((t) => t.match(/\$\s?\d+(\.\d{2})?/)?.[0] ?? null);
  await checkout.click();

  await page
    .getByText(
      /registration (is )?(complete|successful)|successfully registered|your domain is registered/i,
    )
    .waitFor({ timeout: 90_000 })
    .catch(async () => {
      throw new NeedsHuman(
        "cloudflare: no confirmation after checkout",
        await session.screenshot("after-checkout"),
      );
    });
  return { domain, priceText };
}
