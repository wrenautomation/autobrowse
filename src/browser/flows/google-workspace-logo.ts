/**
 * The organization's logo across Gmail, Calendar and Drive. Admin console
 * only, no API. Mapped 2026-09-19 in explore mode: Account settings →
 * Personalization, "Custom logo", "Upload from device" (a file chooser),
 * Save. Google wants 320×132, PNG/GIF/JPEG, under 30 KB.
 */
import { defineFlow } from "../flow.js";

const PAGE = "https://admin.google.com/ac/companyprofile/personalization";

export const googleWorkspaceLogo = defineFlow<{ file: string }, string>({
  site: "google-admin",
  name: "workspace-logo",
  async run(fp, { file }) {
    await fp.open(PAGE);
    await fp.act(
      { kind: "click" },
      { role: "radio", name: "Custom logo" },
      { goal: "custom logo" },
    );
    await fp.act(
      { kind: "upload", files: [file] },
      { role: "button", name: "Upload from device" },
      { goal: "pick the logo file" },
    );
    // The form says "1 unsaved change" once the file is in.
    let uploaded = false;
    for (let i = 0; i < 15 && !uploaded; i++) {
      await fp.wait(1_000);
      uploaded = /unsaved change/i.test(await fp.text());
    }
    if (!uploaded) return fp.human("the logo did not upload (no unsaved change)");
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Save changes" },
      { goal: "save the logo" },
    );
    await fp.wait(3_000);
    const text = (await fp.text()).replace(/\s+/g, " ");
    if (/no logo set/i.test(text)) return fp.human("Google still shows no logo after saving");
    return "logo saved; Google says it can take up to 3 days to show everywhere";
  },
});
