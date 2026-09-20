/**
 * Workspace: "Allow users to skip their password and authenticate with a
 * passkey", on or off. Compiled from the recording "workspace-skip-passwords"
 * (2026-09-21), then edited: the recording clicked the box blind, which
 * toggles; this reads the box first and only clicks when it disagrees with
 * the plan, so re-running is safe. A preset: copy it for any Admin console
 * checkbox setting.
 */

import { z } from "zod";
import { defineFlow, defineWorkflow, done, type FlowRunner, type StepDef } from "../../index.js";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  /** The setting's target state. */
  enabled: z.boolean().default(true),
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

export interface Memo {
  /** Whether the flow had to change anything. */
  changed?: boolean;
}

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

/** The setting's page in the Admin console; the tree walk from the recording is not needed. */
export const PASSWORDLESS_URL =
  "https://admin.google.com/ac/managedsettings/352555445522/passwordless";
const BOX = "Allow users to skip their password and authenticate with a passkey";

export interface SetSkipPasswordsInput {
  enabled: boolean;
}

export const setSkipPasswordsFlow = defineFlow<SetSkipPasswordsInput, { changed: boolean }>({
  site: "google-admin",
  name: "set-skip-passwords",
  async run(fp, input) {
    await fp.open(PASSWORDLESS_URL);
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Edit Skip passwords" },
      { goal: "open the Skip passwords editor" },
    );
    const box = fp.page.getByRole("checkbox", { name: BOX, exact: true });
    await box.waitFor({ timeout: 15_000 });
    if ((await box.isChecked()) === input.enabled) return { changed: false };
    await fp.act({ kind: "click" }, { role: "checkbox", name: BOX }, { goal: `set "${BOX}"` });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Save changes" },
      { goal: "save the setting", irreversible: true },
    );
    return { changed: true };
  },
});

const setSkipPasswords: Step<"set-skip-passwords"> = {
  name: "set-skip-passwords",
  irreversible: true, // a dry run stops here: the box may move
  async run({ fx, deps, plan, memo }) {
    const { changed } = await fx.run("browser set-skip-passwords", () =>
      deps.browser.run(setSkipPasswordsFlow, { enabled: plan.enabled }),
    );
    memo.changed = changed;
    const state = plan.enabled ? "on" : "off";
    return done(changed ? `skip passwords turned ${state}` : `skip passwords already ${state}`);
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "workspace-skip-passwords",
  description:
    "Workspace: let users skip their password for a passkey (on by default; enabled=false turns it off).",
  plan: planSchema,
  steps: [setSkipPasswords],
  emptyMemo: () => ({}),
});
