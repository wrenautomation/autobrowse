/**
 * Gmail DKIM has no API. The admin console generates the key and, once the
 * TXT is live, "Start authentication" turns signing on. Two flows, one per
 * half, so the DNS write sits between them as its own journaled step.
 */
import { defineFlow, type FlowPage } from "../flow.js";

const PAGE = "https://admin.google.com/ac/apps/gmail/authenticateemail";

export interface DkimRecord {
  /** Always `google._domainkey` for the default selector. */
  name: string;
  value: string;
}

async function openDomain(fp: FlowPage, domain: string): Promise<void> {
  await fp.open(PAGE);
  const picker = fp.page.getByRole("combobox").or(fp.page.getByRole("listbox")).first();
  await picker.click({ timeout: 30_000 });
  await fp.page
    .getByRole("option", { name: domain })
    .or(fp.page.getByText(domain, { exact: true }))
    .first()
    .click();
}

export const googleDkimGenerate = defineFlow<{ domain: string }, DkimRecord>({
  site: "google-admin",
  name: "dkim-generate",
  async run(fp, { domain }) {
    const { page } = fp;
    await openDomain(fp, domain);
    const generate = page.getByRole("button", { name: /generate new record/i });
    if (await generate.isVisible().catch(() => false)) {
      await generate.click();
      await page.getByRole("button", { name: /^generate$/i }).click();
    }
    const value = await page
      .locator("text=/^v=DKIM1;/")
      .first()
      .innerText({ timeout: 30_000 })
      .catch(() => null);
    if (value === null) return fp.human(`no DKIM value shown for ${domain}`);
    return { name: "google._domainkey", value: value.trim() };
  },
});

export const googleDkimStart = defineFlow<{ domain: string }, "started" | "already">({
  site: "google-admin",
  name: "dkim-start",
  async run(fp, { domain }) {
    const { page } = fp;
    await openDomain(fp, domain);
    const on = page.getByText(/authenticating email/i);
    if (await on.isVisible().catch(() => false)) return "already";
    const start = page.getByRole("button", { name: /start authentication/i });
    if (
      !(await start.click({ timeout: 30_000 }).then(
        () => true,
        () => false,
      ))
    )
      fp.human(`no Start authentication for ${domain}`);
    if (
      !(await on.waitFor({ timeout: 60_000 }).then(
        () => true,
        () => false,
      ))
    )
      fp.human(`DKIM did not switch on for ${domain} (TXT not visible to Google yet?)`);
    return "started";
  },
});
