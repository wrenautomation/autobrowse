/**
 * Gmail DKIM has no API. The admin console generates the key and, once the
 * TXT is live, "Start authentication" turns signing on. Two calls, one per
 * half, so the DNS write sits between them as its own journaled step.
 */
import { looksLikeWall, NeedsHuman, type Session } from "./session.js";

const PAGE = "https://admin.google.com/ac/apps/gmail/authenticateemail";

export interface DkimRecord {
  /** Always `google._domainkey` for the default selector. */
  name: string;
  value: string;
}

async function openDomain(session: Session, domain: string): Promise<void> {
  const { page } = session;
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  const wall = await looksLikeWall(page);
  if (wall) throw new NeedsHuman(`google admin: ${wall}`, await session.screenshot("wall"));
  const picker = page.getByRole("combobox").or(page.getByRole("listbox")).first();
  await picker.click({ timeout: 30_000 });
  await page
    .getByRole("option", { name: domain })
    .or(page.getByText(domain, { exact: true }))
    .first()
    .click();
}

export async function googleDkimGenerate(session: Session, domain: string): Promise<DkimRecord> {
  const { page } = session;
  await openDomain(session, domain);
  const generate = page.getByRole("button", { name: /generate new record/i });
  if (await generate.isVisible().catch(() => false)) {
    await generate.click();
    await page.getByRole("button", { name: /^generate$/i }).click();
  }
  const value = await page
    .locator("text=/^v=DKIM1;/")
    .first()
    .innerText({ timeout: 30_000 })
    .catch(async () => {
      throw new NeedsHuman(
        `google admin: no DKIM value shown for ${domain}`,
        await session.screenshot("dkim"),
      );
    });
  return { name: "google._domainkey", value: value.trim() };
}

export async function googleDkimStart(
  session: Session,
  domain: string,
): Promise<"started" | "already"> {
  const { page } = session;
  await openDomain(session, domain);
  if (
    await page
      .getByText(/authenticating email/i)
      .isVisible()
      .catch(() => false)
  )
    return "already";
  const start = page.getByRole("button", { name: /start authentication/i });
  await start.click({ timeout: 30_000 }).catch(async () => {
    throw new NeedsHuman(
      `google admin: no Start authentication for ${domain}`,
      await session.screenshot("dkim-start"),
    );
  });
  await page
    .getByText(/authenticating email/i)
    .waitFor({ timeout: 60_000 })
    .catch(async () => {
      throw new NeedsHuman(
        `google admin: DKIM did not switch on for ${domain} (TXT not visible yet?)`,
        await session.screenshot("dkim-start"),
      );
    });
  return "started";
}
