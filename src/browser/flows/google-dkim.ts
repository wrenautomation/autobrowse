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
  // Named: the header's search box is a combobox too. The runner's hands,
  // not a bare click: Google's list opens only for a pointer that moves in.
  const picker = { role: "listbox", name: "Selected domain" };
  await fp.act({ kind: "click" }, picker, { goal: "open the domain list", timeoutMs: 30_000 });
  await fp.act({ kind: "click" }, { role: "option", name: domain }, { goal: `pick ${domain}` });
  await fp.page
    .getByRole("listbox", { name: /selected domain/i })
    .getByRole("option", { name: domain, exact: true, selected: true })
    .waitFor({ state: "attached", timeout: 15_000 });
  // The panel below redraws for the new domain; let it settle before reading it.
  await fp.wait(2_000);
}

export const googleDkimGenerate = defineFlow<{ domain: string }, DkimRecord>({
  site: "google-admin",
  name: "dkim-generate",
  async run(fp, { domain }) {
    await openDomain(fp, domain);
    const shown = { text: "/^v=DKIM1;/" };
    // A key already shown is the live one (a domain getting more inboxes):
    // "Generate new record" stays on the page and would rotate it.
    if (!(await fp.has(shown, 10_000))) {
      await fp.act(
        { kind: "click" },
        { role: "button", name: "/generate new record/i" },
        { goal: "open the generate dialog", timeoutMs: 30_000 },
      );
      await fp.act(
        { kind: "click" },
        { role: "button", name: "/^generate$/i" },
        { goal: "generate the DKIM key (a second one rotates it)", irreversible: true },
      );
    }
    if (!(await fp.has(shown, 30_000))) return fp.human(`no DKIM value shown for ${domain}`);
    return { name: "google._domainkey", value: (await fp.read(shown)).trim() };
  },
});

export const googleDkimStart = defineFlow<{ domain: string }, "started" | "already">({
  site: "google-admin",
  name: "dkim-start",
  async run(fp, { domain }) {
    const { page } = fp;
    await openDomain(fp, domain);
    // Several matches (the status, help text): one visible is the answer, and
    // a bare locator would throw on strictness and read as "not on".
    const on = page
      .getByText(/authenticating email with dkim/i)
      .filter({ visible: true })
      .first();
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
