/**
 * Make a free npm org (unlimited public packages), so packages can publish
 * under its scope. A page only: the registry will not make orgs, and a token
 * that bypasses 2FA may not change the account.
 *
 * Mapped live 2026-09-30 (recordings/npm-create-org):
 *   /org/create: textbox id `create_orgScope` ("Name", fixed once made);
 *     button "Buy" ($7/month, private packages) and button "Create" (free)
 *   Create → /org/<name>/invite; "Skip this for now" → /settings/<name>/members
 * A taken name shows no inline error: the page just stays on /org/create.
 * An org we already own opens its members page instead of npm's 404.
 */
import { defineFlow } from "../flow.js";

export interface CreateOrgInput {
  /** The scope without `@`: lowercase, url-safe. */
  name: string;
}

export interface CreateOrgResult {
  org: string;
  /** True when the account already owned the org. */
  existed: boolean;
}

const members = (name: string) => `https://www.npmjs.com/settings/${name}/members`;
const onOrg = (name: string) => (url: string) =>
  url.includes(`/org/${name}/`) || url.includes(`/settings/${name}/`);

export const npmCreateOrg = defineFlow<CreateOrgInput, CreateOrgResult>({
  site: "npm",
  name: "create-org",
  async run(fp, input) {
    await fp.open(members(input.name));
    if (fp.url().startsWith(members(input.name)) && !/not found/i.test(await fp.text()))
      return { org: input.name, existed: true };
    await fp.open("https://www.npmjs.com/org/create");
    await fp.act(
      { kind: "fill", value: input.name },
      { id: "create_orgScope" },
      {
        goal: "the org name (fixed once made)",
      },
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Create" },
      { goal: "the free plan: unlimited public packages", irreversible: true },
    );
    if (!(await fp.waitForUrl(onOrg(input.name), 20_000)))
      return fp.human(`npm did not make @${input.name}: the name may be taken`);
    return { org: input.name, existed: false };
  },
});
