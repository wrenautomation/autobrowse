/**
 * Trust a CI workflow to publish a package over OIDC: no token in CI at
 * all. npm keeps this behind real 2FA (a bypass token may not change the
 * account), so it is a page, unlocked with our security key.
 *
 * Mapped live 2026-09-22 at /package/<name>/access (tab "Settings"):
 *   button "Add Trusted Publisher connection for GitHub Actions"
 *   textbox "Label" (optional), "Organization or user*", "Repository*",
 *     "Workflow filename*" (file name only), "Environment name"
 *   checkbox "Allow npm publish"   off = `npm stage publish` only
 *   button "Set up new trusted publisher connection"
 * Provider, owner, repository and workflow cannot be changed afterwards.
 */
import { unlockWithPasskey } from "../../auth/recovery.js";
import { defineFlow } from "../flow.js";

export interface TrustedPublisherInput {
  package: string;
  /** GitHub org or user. */
  owner: string;
  repo: string;
  /** File name under .github/workflows/, e.g. release.yml. */
  workflow: string;
  environment?: string;
  /** Let the workflow `npm publish` directly, not only stage. */
  allowPublish?: boolean;
}

export interface TrustedPublisherResult {
  package: string;
  /** `owner/repo:workflow`, as the connection reads. */
  trusted: string;
  /** True when the connection was already there. */
  existed: boolean;
}

const USE_KEY = { role: "button", name: "Use security key" } as const;

/** The settings panel lists a connection by its repository and workflow file. */
const listed = (text: string, i: TrustedPublisherInput): boolean =>
  text.includes(`${i.owner}/${i.repo}`) && text.includes(i.workflow);

export const npmTrustedPublisher = defineFlow<TrustedPublisherInput, TrustedPublisherResult>({
  site: "npm",
  name: "trusted-publisher",
  async run(fp, input) {
    const trusted = `${input.owner}/${input.repo}:${input.workflow}`;
    const url = `https://www.npmjs.com/package/${encodeURIComponent(input.package)}/access`;
    await fp.open(url);
    await unlockWithPasskey(fp, USE_KEY);
    const add = { role: "button", name: "Add Trusted Publisher connection for GitHub Actions" };
    if (!(await fp.has(add, 8_000))) {
      if (listed(await fp.text(), input)) return { package: input.package, trusted, existed: true };
      return fp.human(`${input.package} settings show no trusted publisher form`);
    }
    await fp.act({ kind: "click" }, add, { goal: "trust a GitHub Actions workflow" });
    const box = (name: string) => ({ role: "textbox", name });
    await fp.act({ kind: "fill", value: input.owner }, box("Organization or user*"), {
      goal: "the GitHub owner",
    });
    await fp.act({ kind: "fill", value: input.repo }, box("Repository*"), { goal: "the repo" });
    await fp.act({ kind: "fill", value: input.workflow }, box("Workflow filename*"), {
      goal: "the workflow file",
    });
    if (input.environment)
      await fp.act({ kind: "fill", value: input.environment }, box("Environment name"), {
        goal: "the GitHub environment",
      });
    if (input.allowPublish)
      await fp.act(
        { kind: "click" },
        { role: "checkbox", name: "Allow npm publish" },
        { goal: "let it publish, not only stage" },
      );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Set up new trusted publisher connection" },
      { goal: "create the connection (fixed once made)", irreversible: true },
    );
    await unlockWithPasskey(fp, USE_KEY);
    for (let i = 0; i < 10; i++) {
      await fp.wait(1_500);
      const text = await fp.text();
      if (listed(text, input) && !(await fp.has(box("Repository*"), 500)))
        return { package: input.package, trusted, existed: false };
    }
    return fp.human(`the ${trusted} connection did not show on ${input.package}'s settings`);
  },
});
