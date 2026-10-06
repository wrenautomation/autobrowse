/**
 * Upload a new profile photo on Instagram by opening the photo-change dialog and selecting an image file to set as the account's profile picture..
 * Compiled from the recording "instagram-profile-basics". Edit freely: the outline was the
 * source until this file was written; from here on this file is.
 * Finished: split the upload into a fill and a send step, added proof.
 */

import { z } from "zod";
import {
  defineFlow,
  defineWorkflow,
  done,
  type FlowRunner,
  rejected,
  type StepDef,
  skipped,
} from "../../index.js";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  profilePhotoFile: z.string().min(1).describe("Change photo"), // e.g. "/Users/williamjin/Documents/wren_automation/autobrowse/assets/brand/wren-pfp.png"
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

export interface Memo {
  /** What the API said after the upload. */
  proof?: string;
}

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export interface UploadProfilePhotoInput {
  profilePhotoFile: string;
  /** Click Upload and read the confirmation; false leaves the filled form for a look. */
  submit: boolean;
}

/** Fill the form; with `submit`, send it and return what the API said. */
const uploadProfilePhotoFlow = defineFlow<UploadProfilePhotoInput, { proof: string | null }>({
  // Changed return type
  site: "instagram",
  name: "upload-profile-photo",
  async run(fp, input) {
    await fp.open("https://www.instagram.com/accounts/edit/");
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Change photo" },
      { goal: "click Change photo" },
    );
    if (!input.submit) return { proof: null };
    // With a photo already set, Change photo opens a menu and its "Upload Photo" takes the file.
    const menu = await fp.has({ role: "button", name: "Upload Photo" }, 3_000);
    await fp.act(
      { kind: "upload", files: [input.profilePhotoFile] },
      { role: "button", name: menu ? "Upload Photo" : "Change photo" },
      { goal: "upload the profile photo", irreversible: true },
    );
    await fp.wait(3_000);
    const text = await fp.text();
    if (
      /error|required|invalid/i.test(text) &&
      (await fp.has({ role: "button", name: "Change photo" }))
    )
      fp.human("Instagram did not accept the upload; see the screenshot");
    const said = text.match(/(uploaded|updated|success|profile picture)[^\n]*/i);
    return { proof: said ? said[0].trim() : text.slice(0, 300) };
  },
});

const fill: Step<"fill"> = {
  name: "fill",
  async run({ fx, deps, plan }) {
    await fx.run("browser fill profile photo form", () =>
      deps.browser.run(uploadProfilePhotoFlow, { ...plan, submit: false }),
    );
    return done(`form filled for ${plan.profilePhotoFile}, not sent`);
  },
};

const upload: Step<"upload"> = {
  name: "upload",
  irreversible: true,
  async run({ fx, deps, plan, memo, gate }) {
    if (memo.proof) return skipped("already uploaded");
    const answer = gate("send", `Upload ${plan.profilePhotoFile} as the Instagram profile photo?`);
    if (!answer.approved) return rejected(answer.note ?? "not uploaded");
    const { proof } = await fx.run("browser upload profile photo", () =>
      deps.browser.run(uploadProfilePhotoFlow, { ...plan, submit: true }),
    );
    memo.proof = proof ?? "uploaded";
    return done(`uploaded; Instagram said: ${memo.proof}`);
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "instagram-profile-basics",
  description:
    "Upload a new profile photo on Instagram by opening the photo-change dialog and selecting an image file to set as the account's profile picture.",
  plan: planSchema,
  steps: [fill, upload],
  emptyMemo: () => ({}),
});
