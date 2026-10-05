/**
 * Set a LinkedIn company Page's logo, banner and website from its admin editor.
 * Hand-written from the 2026-10-05 explore run on Wren's Page. What the editor does:
 * - A logo and a banner saved together keep only the banner: each gets its own Save.
 * - The banner opens an image editor on the old cover; the new file goes in its
 *   "Change image" input, then Apply, which shows "Saving" until the upload lands.
 * - Every Save opens "Share your page edits"; "No thanks" closes it. Nothing is posted.
 * - The Save click can time out while that dialog opens over it, though the save went through.
 * Runs on the `linkedin` profile: a Page admin. Wren's own account can't be one until
 * LinkedIn verifies it (government ID, William's step).
 */

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

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  companyId: z.string().regex(/^\d+$/).default("143656154").describe("The Page's numeric id"),
  logoFile: z.string().min(1).optional().describe("Logo, square"), // e.g. "/Users/williamjin/Documents/wren_automation/autobrowse/assets/brand/wren-pfp-rust-on-white.png"
  bannerFile: z.string().min(1).optional().describe("Banner, 1584x396"), // e.g. "/Users/williamjin/Documents/wren_automation/autobrowse/assets/brand/wren-banner-linkedin-rust-on-white.png"
  website: z.string().url().optional().describe("Website URL"), // e.g. "https://wrenautomation.com"
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

export interface Memo {
  /** What the editor showed after the last save. */
  proof?: string;
}

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export interface BrandPageInput {
  companyId: string;
  logoFile?: string | undefined;
  bannerFile?: string | undefined;
  website?: string | undefined;
  /** Upload and save; false opens the editor as admin and stops. */
  submit: boolean;
}

const SAVE: Hints = { id: "org-page-edit-modal-banner__save-button" };
const NO_THANKS: Hints = { role: "button", name: "No thanks" };
const COVER_DIALOG: Hints = { role: "dialog", name: "Cover Image" };
const WEBSITE: Hints = { id: "organization-website-field" };

const editor = (id: string, tab: "info" | "details") =>
  `https://www.linkedin.com/company/${id}/admin/edit/?editPageActiveTab=${tab}`;

/**
 * Open an editor tab, signed in. A Google sign-in leaves LinkedIn a session-only
 * cookie, so a fresh browser lands on /authwall, sometimes after the page first loads.
 */
async function openEditor(fp: FlowPage, id: string, tab: "info" | "details"): Promise<void> {
  await fp.open(editor(id, tab));
  if (!(await fp.waitForUrl(/linkedin\.com\/authwall/, 4_000))) return;
  if ((await fp.signIn("linkedin")) !== "signed-in")
    fp.human("LinkedIn is signed out and sign-in failed");
  await fp.open(editor(id, tab));
}

/** Save, close "Share your page edits" without posting, and check the edit stuck. */
async function save(fp: FlowPage, what: string): Promise<void> {
  try {
    await fp.act({ kind: "click" }, SAVE, { goal: `save ${what}`, irreversible: true });
  } catch (err) {
    if (!(await fp.has(NO_THANKS, 5_000))) throw err;
  }
  if (await fp.has(NO_THANKS, 10_000))
    await fp.act({ kind: "click" }, NO_THANKS, { goal: "skip the share-your-edits post" });
  if (await fp.has(SAVE, 2_000)) fp.human(`LinkedIn still shows Save after saving ${what}`);
}

const brandPageFlow = defineFlow<BrandPageInput, { proof: string | null }>({
  site: "linkedin",
  name: "brand-page",
  async run(fp, input) {
    await openEditor(fp, input.companyId, "info");
    if (!(await fp.has({ id: "organization-logo-field" }, 10_000)))
      fp.human(
        `no Page editor at ${fp.url()}: this profile is not a super admin of ${input.companyId}`,
      );
    if (!input.submit) return { proof: null };
    const saved: string[] = [];

    if (input.logoFile) {
      await fp.act(
        { kind: "upload", files: [input.logoFile] },
        { id: "organization-logo-field" },
        {
          goal: "upload the logo",
        },
      );
      await save(fp, "the logo");
      saved.push("logo");
    }

    if (input.bannerFile) {
      await fp.act(
        { kind: "click" },
        { role: "button", name: "Edit background" },
        {
          goal: "open the banner menu",
        },
      );
      await fp.act(
        { kind: "click" },
        { text: "Edit cover image" },
        { goal: "open the cover editor" },
      );
      await fp.act(
        { kind: "upload", files: [input.bannerFile] },
        { id: "org-image-editor__change-photo-input" },
        { goal: "upload the banner" },
      );
      await fp.act(
        { kind: "click" },
        { role: "button", name: "Apply" },
        { goal: "apply the banner" },
      );
      for (let i = 0; i < 30 && (await fp.has(COVER_DIALOG)); i++) await fp.wait(1_000);
      if (await fp.has(COVER_DIALOG)) fp.human("the cover editor never finished saving the banner");
      await save(fp, "the banner");
      saved.push("banner");
    }

    if (input.website) {
      await openEditor(fp, input.companyId, "details");
      const now = await fp.page.locator("#organization-website-field").inputValue();
      if (now !== input.website) {
        await fp.act({ kind: "fill", value: input.website }, WEBSITE, { goal: "set the website" });
        await save(fp, "the website");
        await openEditor(fp, input.companyId, "details");
        const after = await fp.page.locator("#organization-website-field").inputValue();
        if (after !== input.website)
          fp.human(`website reads ${after} after saving ${input.website}`);
      }
      saved.push(`website ${input.website}`);
    }

    return { proof: saved.length ? `saved ${saved.join(", ")}` : "nothing to change" };
  },
});

const check: Step<"check"> = {
  name: "check",
  async run({ fx, deps, plan }) {
    await fx.run("browser open the Page editor", () =>
      deps.browser.run(brandPageFlow, { ...plan, submit: false }),
    );
    return done(`editor open as admin of ${plan.companyId}, nothing changed`);
  },
};

const brand: Step<"brand"> = {
  name: "brand",
  irreversible: true,
  async run({ fx, deps, plan, memo, gate }) {
    if (memo.proof) return skipped("already saved");
    const parts = [
      plan.logoFile && `logo ${plan.logoFile}`,
      plan.bannerFile && `banner ${plan.bannerFile}`,
      plan.website && `website ${plan.website}`,
    ].filter(Boolean);
    if (!parts.length) return skipped("no logo, banner or website given");
    const answer = gate("send", `Set LinkedIn Page ${plan.companyId}: ${parts.join("; ")}?`);
    if (!answer.approved) return rejected(answer.note ?? "not changed");
    const { proof } = await fx.run("browser brand the Page", () =>
      deps.browser.run(brandPageFlow, { ...plan, submit: true }),
    );
    memo.proof = proof ?? "saved";
    return done(memo.proof);
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "linkedin-page-branding",
  description:
    "Set a LinkedIn company Page's logo, banner and website from its admin editor, one save each, declining the share-your-edits post.",
  plan: planSchema,
  steps: [check, brand],
  emptyMemo: () => ({}),
});
