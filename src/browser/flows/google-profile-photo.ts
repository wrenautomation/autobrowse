/**
 * A Google account's own profile picture: the round picture beside the
 * name in Gmail. An animated GIF stays animated (served as a GIF at every
 * size; Gmail's inbox list shows its first frame, an opened mail plays it).
 * No API keeps the animation, so it is the account's own page. Mapped
 * 2026-09-25 in explore mode: Personal info → "Profile picture" opens an
 * editor in an iframe → "Upload from Device" (a file chooser) → "Crop &
 * rotate" → Next → "Save as profile picture". Site it into the account's
 * profile: `{ ...googleProfilePhoto, site: "google@<label>" }`.
 */
import { defineFlow } from "../flow.js";

const PAGE = "https://myaccount.google.com/personal-info";
const EDITOR = 'iframe[src*="profile-picture"]';

export const googleProfilePhoto = defineFlow<{ file: string }, string>({
  site: "google",
  name: "profile-photo",
  async run(fp, { file }) {
    await fp.open(PAGE);
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Profile picture" },
      { goal: "open the picture editor" },
    );
    await fp.act(
      { kind: "upload", files: [file] },
      { frame: EDITOR, role: "button", name: "Upload from Device" },
      { goal: "pick the picture", timeoutMs: 15_000 },
    );
    // "Uploading photo..." for a few seconds, then the crop.
    await fp.act(
      { kind: "click" },
      { frame: EDITOR, role: "button", name: "Next" },
      { goal: "keep the crop", timeoutMs: 30_000 },
    );
    await fp.act(
      { kind: "click" },
      { frame: EDITOR, role: "button", name: "Save as profile picture" },
      { goal: "save the picture", timeoutMs: 15_000 },
    );
    await fp.wait(5_000);
    if (await fp.has({ frame: EDITOR, role: "button", name: "Save as profile picture" }))
      return fp.human("the picture did not save");
    return "picture saved; Google says a day or two to show everywhere";
  },
});
