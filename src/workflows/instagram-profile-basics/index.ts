/**
 * Upload a new profile photo on Instagram by opening the photo-change dialog and selecting an image file to set as the account's profile picture..
 * Compiled from the recording "instagram-profile-basics". Edit freely: the outline was the
 * source until this file was written; from here on this file is.
 */

import { z } from "zod";
import {
  defineFlow,
  defineWorkflow,
  done,
  type FlowRunner,
  rejected,
  type StepDef,
} from "../../index.js";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  profilePhotoFile: z.string().min(1).describe("Change photo"), // e.g. "/Users/williamjin/Documents/wren_automation/autobrowse/assets/brand/wren-pfp.png"
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export interface UploadProfilePhotoInput {
  profilePhotoFile: string;
}

const uploadProfilePhotoFlow = defineFlow<UploadProfilePhotoInput, void>({
  site: "instagram",
  name: "upload-profile-photo",
  async run(fp, input) {
    await fp.open("https://www.instagram.com/accounts/edit/");
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Change photo" },
      { goal: "click Change photo" },
    ); // page.getByRole("button", { name: "Change photo", exact: true })
    await fp.act(
      { kind: "upload", files: [input.profilePhotoFile] },
      { role: "button", name: "Change photo" },
      { goal: "upload to Change photo" },
    ); // page.getByRole("button", { name: "Change photo", exact: true })
  },
});

const uploadProfilePhoto: Step<"upload-profile-photo"> = {
  name: "upload-profile-photo",
  irreversible: true,
  async run({ fx, deps, plan, gate }) {
    const answer = gate(
      "human",
      "Run \"upload-profile-photo\" (Click 'Change photo' on the Instagram profile edit page and upload the specified image file as the new profile picture.)?",
    );
    if (!answer.approved) return rejected(answer.note ?? "declined");
    await fx.run("browser upload-profile-photo", () =>
      deps.browser.run(uploadProfilePhotoFlow, { profilePhotoFile: plan.profilePhotoFile }),
    );
    // TODO proof: GET https://graph.instagram.com/me?fields=profile_picture_url (Instagram Graph API) to confirm the profile picture URL reflects the newly uploaded image.
    return done(
      "Click 'Change photo' on the Instagram profile edit page and upload the specified image file as the new profile picture.",
    );
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "instagram-profile-basics",
  description:
    "Upload a new profile photo on Instagram by opening the photo-change dialog and selecting an image file to set as the account's profile picture.",
  plan: planSchema,
  steps: [uploadProfilePhoto],
  emptyMemo: () => ({}),
});
