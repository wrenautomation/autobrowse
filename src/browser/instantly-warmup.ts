/**
 * Warmup lives in Instantly (warmup only; sends go through wren). Adding a
 * Google inbox there is an OAuth consent the inbox's own Google session must
 * give, so the flow opens the add dialog and hands the consent to a human,
 * then checks the account is listed with warmup on.
 */
import { looksLikeWall, NeedsHuman, type Session } from "./session.js";

const ACCOUNTS = "https://app.instantly.ai/app/accounts";

export async function instantlyWarmup(
  session: Session,
  email: string,
): Promise<"enrolled" | "already"> {
  const { page } = session;
  await page.goto(ACCOUNTS, { waitUntil: "domcontentloaded" });
  const wall = await looksLikeWall(page);
  if (wall) throw new NeedsHuman(`instantly: ${wall}`, await session.screenshot("wall"));
  if (
    await page
      .getByText(email, { exact: true })
      .isVisible()
      .catch(() => false)
  )
    return "already";
  await page.getByRole("button", { name: /add new/i }).click({ timeout: 30_000 });
  await page
    .getByText(/google/i)
    .first()
    .click();
  throw new NeedsHuman(
    `instantly: finish the Google consent for ${email} in the open browser, then approve the gate`,
    await session.screenshot("oauth"),
  );
}
