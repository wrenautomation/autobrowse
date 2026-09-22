/**
 * The browser half of "does this account exist": open the site's forgot-
 * password page, put the address in, send. It reports whether the form
 * took the address, nothing more — the answer is in the inbox, and
 * `lookForAccount` reads it there.
 *
 * Asking for a reset link changes nothing: no password moves until someone
 * opens the link, and this flow never does.
 */
import type { ResetForm } from "../../auth/exists.js";
import { defineFlow } from "../flow.js";

export interface ResetProbeInput {
  email: string;
  form: ResetForm;
}

const SETTLE_MS = 2_000;
const RENDER_MS = 15_000;

export const resetMailProbe = defineFlow<ResetProbeInput, { asked: boolean }>({
  site: "account",
  name: "reset-mail-probe",
  async run(fp, input) {
    await fp.open(input.form.url, { allowWall: true });
    if (!(await fp.has(input.form.field, RENDER_MS)))
      return fp.human(`no address field on ${fp.url()}: the reset page moved`);
    await fp.act({ kind: "fill", value: input.email }, input.form.field, {
      goal: "the address being asked about",
    });
    await fp.act({ kind: "click" }, input.form.submit, { goal: "ask for a reset link" });
    await fp.wait(SETTLE_MS);
    return { asked: true };
  },
});
