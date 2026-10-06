/**
 * Set William's personal LinkedIn profile photo. Only when he asks: it is his
 * account. Mapped read-only from his profile 2026-10-05 (the new UI, classes
 * obfuscated, so roles and names only):
 * - /in/me/ shows a link "Profile photo"; it opens dialog "Profile photo" with
 *   "Edit", "Update", "Frames", "Delete". A profile with no photo may open the
 *   upload dialog straight away.
 * - "Update" opens dialog "Update": "Use Camera" and "Upload photo" (a file chooser).
 * - The file lands in "Edit image" (crop, filter, adjust); "Save changes" saves it.
 * - Anything after that asking to share the update is declined; its post button is never clicked.
 * - The photo reads back by URL: a new upload gets a new asset id.
 * Runs in the profile where his LinkedIn signs in (Google).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  defineFlow,
  defineWorkflow,
  done,
  type FlowPage,
  type FlowRunner,
  type Hints,
  rejected,
  type StepDef,
  skipped,
} from "../../index.js";
import { type ImageRule, imageProblem } from "../image.js";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  photoFile: z.string().min(1).describe("A square photo of William, 400px or more"), // e.g. "/Users/williamjin/Documents/wren_automation/autobrowse/assets/people/william-headshot-square.png"
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

export interface Memo {
  /** sha256 of the file once it read back: a rerun skips it. */
  saved?: string;
}

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export interface ProfilePhotoInput {
  /** null opens the profile and reads the photo. */
  file: string | null;
}

export interface ProfilePhotoOutput {
  /** The photo's URL after the run; null when none shows. */
  photo: string | null;
  outcome: "saved" | "read";
}

/** LinkedIn's guide: 400x400 and up. It crops to a circle: near square. */
export const RULE: ImageRule = {
  what: "photo",
  minWidth: 400,
  minHeight: 400,
  aspect: [0.8, 1.25],
  maxBytes: 8e6,
};

const ME = "https://www.linkedin.com/in/me/";
const WALL = /linkedin\.com\/(authwall|login|uas\/|checkpoint)/;
const PHOTO_LINK: Hints = { role: "link", name: "Profile photo" };
const PHOTO_DIALOG: Hints = { role: "dialog", name: "Profile photo" };
// In a dialog, by role and exact name: the dialogs are native <dialog> (no role
// attribute, so no [role=dialog]) and a label sits in a child <p> (so no :text-is).
const IN_DIALOG = (role: "link" | "button", name: string): Hints => ({
  css: `dialog >> role=${role}[name="${name}"s]`,
});
const UPDATE: Hints[] = [
  IN_DIALOG("link", "Update"),
  IN_DIALOG("button", "Update"),
  IN_DIALOG("button", "Add photo"),
];
const UPLOAD = IN_DIALOG("button", "Upload photo");
const EDIT_IMAGE: Hints = { role: "heading", name: "Edit image" };
const SAVE: Hints[] = [
  IN_DIALOG("button", "Save changes"),
  IN_DIALOG("button", "Save photo"),
  IN_DIALOG("button", "Save"),
  IN_DIALOG("button", "Apply"),
];
// A share-your-update prompt: the way out, never its post button.
const DECLINE: Hints[] = [
  IN_DIALOG("button", "No thanks"),
  IN_DIALOG("button", "Skip"),
  IN_DIALOG("button", "Not now"),
];
const DISMISS = IN_DIALOG("button", "Dismiss");

async function shown(fp: FlowPage, options: Hints[], withinMs = 0): Promise<Hints | null> {
  for (const h of options) if (await fp.has(h, withinMs || undefined)) return h;
  return null;
}

/** /in/me/, signed in: one sign-in try, then a person. */
async function openProfile(fp: FlowPage): Promise<void> {
  await fp.open(ME);
  if (WALL.test(fp.url()) || (await fp.waitForUrl(WALL, 4_000))) {
    if ((await fp.signIn()) !== "signed-in")
      fp.human("LinkedIn is signed out and the one sign-in try failed");
    await fp.open(ME);
  }
  if (!(await fp.has(PHOTO_LINK, 20_000)))
    fp.human(`no profile photo on ${fp.url()}: not William's profile, or the page changed`);
}

/** The top card's photo URL: the profile-displayphoto image inside the photo link. */
async function readPhoto(fp: FlowPage): Promise<string | null> {
  return fp.page
    .getByRole("link", { name: "Profile photo", exact: true })
    .locator("img")
    .first()
    .getAttribute("src", { timeout: 3_000 })
    .catch(() => null);
}

/** Signs in as the flow's site: `{ ...profilePhotoFlow, site: "linkedin@wren" }` runs it there. */
export const profilePhotoFlow = defineFlow<ProfilePhotoInput, ProfilePhotoOutput>({
  site: "linkedin",
  name: "profile-photo",
  // William's account signs in by Google: its session lives in that profile.
  profile: "provider",
  async run(fp, { file }) {
    await openProfile(fp);
    const before = await readPhoto(fp);
    if (!file) return { photo: before, outcome: "read" };

    await fp.act({ kind: "click" }, PHOTO_LINK, { goal: "open the profile photo" });
    // A profile with a photo shows it first; one without may go straight to upload.
    if (await fp.has(PHOTO_DIALOG, 8_000)) {
      const update = await shown(fp, UPDATE, 5_000);
      if (!update) return fp.human("the profile photo dialog has no Update");
      await fp.act({ kind: "click" }, update, { goal: "choose a new photo" });
    }
    if (!(await fp.has(UPLOAD, 8_000))) fp.human("no Upload photo button");
    await fp.act({ kind: "upload", files: [file] }, UPLOAD, { goal: "upload the photo" });
    if (!(await fp.has(EDIT_IMAGE, 20_000))) fp.human("the photo never reached the image editor");
    const save = await shown(fp, SAVE);
    if (!save) return fp.human("the image editor has no save button");
    await fp.act({ kind: "click" }, save, { goal: "save the photo", irreversible: true });

    // Saving can end on the photo dialog or a share prompt: close either without posting.
    await fp.wait(3_000);
    const decline = await shown(fp, DECLINE, 3_000);
    if (decline) await fp.act({ kind: "click" }, decline, { goal: "skip sharing the update" });
    if (await fp.has(DISMISS))
      await fp.act({ kind: "click" }, DISMISS, { goal: "close the dialog" });

    for (let i = 0; i < 3; i++) {
      await openProfile(fp);
      const after = await readPhoto(fp);
      if (after && after !== before) return { photo: after, outcome: "saved" };
      await fp.wait(5_000);
    }
    return fp.human("LinkedIn still shows the old profile photo after saving the new one");
  },
});

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

const check: Step<"check"> = {
  name: "check",
  async run({ fx, deps, plan }) {
    const problem = imageProblem(plan.photoFile, RULE);
    if (problem) throw new Error(problem);
    const { photo } = await fx.run("browser read the profile photo", () =>
      deps.browser.run(profilePhotoFlow, { file: null }),
    );
    return done(photo ? "signed in, profile has a photo" : "signed in, no photo shows");
  },
};

const set: Step<"set"> = {
  name: "set",
  irreversible: true,
  async run({ fx, deps, plan, memo, gate }) {
    const mark = sha(plan.photoFile);
    if (memo.saved === mark) return skipped("already set");
    const answer = gate("send", `Set William's LinkedIn profile photo to ${plan.photoFile}?`);
    if (!answer.approved) return rejected(answer.note ?? "not changed");
    await fx.run("browser set the profile photo", () =>
      deps.browser.run(profilePhotoFlow, { file: plan.photoFile }),
    );
    memo.saved = mark;
    return done("photo saved, read back");
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "linkedin-profile-photo",
  description:
    "Set William's personal LinkedIn profile photo (only when he asks): file checked, uploaded, saved, read back, any share prompt declined.",
  plan: planSchema,
  steps: [check, set],
  emptyMemo: () => ({}),
});
