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
 * 2026-10-29: the add button reads "Add trusted publisher connection"; a made connection lists
 * "Permissions: npm publish npm stage publish" (stage only without publish) and its "Edit" opens
 * the same form, fixed fields disabled, saved by "Save changes to trusted publisher connection".
 */
import { unlockWithPasskey } from "../../auth/recovery.js";
import { already } from "../attempt.js";
import { defineFlow } from "../flow.js";

export interface TrustedPublisherInput {
  package: string;
  /** GitHub org or user. */
  owner: string;
  repo: string;
  /** File name under .github/workflows/, e.g. release.yml. */
  workflow: string;
  environment?: string;
  /** Let the workflow `npm publish` directly (true, the default) or only stage (false). */
  allowPublish?: boolean;
}

export interface TrustedPublisherResult {
  package: string;
  /** `owner/repo:workflow`, as the connection reads. */
  trusted: string;
  /** True when the connection was already there. */
  existed: boolean;
  /** Whether it may `npm publish`, as the settings list it after the run. */
  publishes: boolean;
}

const USE_KEY = { role: "button", name: "Use security key" } as const;

/** The settings panel lists a connection by its repository and workflow file. */
const listed = (text: string, i: TrustedPublisherInput): boolean =>
  text.includes(`${i.owner}/${i.repo}`) && text.includes(i.workflow);
/** "npm stage publish" alone is stage only. */
const publishes = (text: string): boolean => /permissions:[^\n]*\bnpm publish/i.test(text);
const ALLOW = { role: "checkbox", name: "Allow npm publish" } as const;

export const npmTrustedPublisher = defineFlow<TrustedPublisherInput, TrustedPublisherResult>({
  site: "npm",
  name: "trusted-publisher",
  async run(fp, input) {
    const trusted = `${input.owner}/${input.repo}:${input.workflow}`;
    // A scoped name keeps its `@` and `/`: npm's site does not route them encoded.
    const url = `https://www.npmjs.com/package/${encodeURI(input.package)}/access`;
    await fp.open(url);
    await unlockWithPasskey(fp, USE_KEY);
    const want = input.allowPublish ?? true;
    const add = { role: "button", name: "/^add trusted publisher/i" };
    if (!(await fp.has(add, 8_000)))
      return fp.human(`${input.package} settings show no trusted publisher form`);
    const shown = await fp.text();
    if (listed(shown, input)) {
      if (publishes(shown) === want)
        return already({ package: input.package, trusted, existed: true, publishes: want });
      // one connection per package here: a second Edit would be ambiguous
      if ((await fp.page.getByRole("button", { name: "Edit", exact: true }).count()) !== 1)
        return fp.human(
          `${input.package} lists several trusted publishers: edit ${trusted} by hand`,
        );
      await fp.act(
        { kind: "click" },
        { role: "button", name: "Edit" },
        { goal: "edit the connection" },
      );
      await setAllow(want);
      await fp.act(
        { kind: "click" },
        { role: "button", name: "Save changes to trusted publisher connection" },
        { goal: want ? "save: it may publish" : "save: stage only" },
      );
      return settle(true);
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
    await setAllow(want);
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Set up new trusted publisher connection" },
      { goal: "create the connection (fixed once made)", irreversible: true },
    );
    return settle(false);

    // the box to what was asked, whatever its default: a click only toggles
    async function setAllow(on: boolean) {
      if ((await fp.page.getByRole("checkbox", { name: ALLOW.name }).isChecked()) !== on)
        await fp.act({ kind: "click" }, ALLOW, {
          goal: on ? "let it publish, not only stage" : "stage only",
        });
    }

    async function settle(existed: boolean): Promise<TrustedPublisherResult> {
      await unlockWithPasskey(fp, USE_KEY);
      for (let i = 0; i < 10; i++) {
        await fp.wait(1_500);
        const text = await fp.text();
        if (listed(text, input) && !(await fp.has({ role: "textbox", name: "Repository*" }, 500))) {
          if (publishes(text) !== want)
            return fp.human(`${trusted} on ${input.package} saved, but publish reads ${!want}`);
          return { package: input.package, trusted, existed, publishes: want };
        }
      }
      return fp.human(`the ${trusted} connection did not show on ${input.package}'s settings`);
    }
  },
});
