/**
 * Set a LinkedIn company Page's logo, banner and website from its admin editor.
 * Hand-written from the 2026-10-05 explore run on Wren's Page, branches mapped
 * from its aria tree the same day. What the editor does:
 * - A logo and a banner saved together keep only the banner: each change gets
 *   its own flow run and its own Save, and is memoized once it reads back.
 * - Save shows only while the form is dirty: an edit with no Save never registered.
 * - The banner sits under "Edit background": "Edit cover image" opens an image
 *   editor on the old cover (new file in its "Change image" input, then Apply,
 *   which shows "Saving" until the upload lands). A Page with no cover may offer
 *   "Upload cover image", which opens the file chooser itself.
 * - The cover editor's Apply saves the cover itself; the Page's Save may not show after.
 * - Every save opens "Share your page edits". "No thanks" closes it; its own
 *   dismiss, then Escape, if that button moves. Its Share button is never clicked.
 * - The Save click can time out while that dialog opens over it, though the save went through.
 * - The website field fills in a beat after the tab loads: read it once it settles.
 * - Images read back by URL (a new upload gets a new asset id), the website by value.
 * Runs in the profile where William's LinkedIn signs in (Google): a Page admin.
 * Wren's own account can't be one until LinkedIn verifies it (government ID, William's step).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Dialog } from "playwright";
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
  companyId: z.string().regex(/^\d+$/).default("143656154").describe("The Page's numeric id"),
  logoFile: z.string().min(1).optional().describe("Logo, square"), // e.g. "/Users/williamjin/Documents/wren_automation/autobrowse/assets/brand/wren-pfp-lavender-on-white.png"
  bannerFile: z.string().min(1).optional().describe("Banner, 1584x396"), // e.g. "/Users/williamjin/Documents/wren_automation/autobrowse/assets/brand/wren-banner-linkedin-lavender-on-white.png"
  website: z.string().url().optional().describe("Website URL"), // e.g. "https://wrenautomation.com"
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

export type Item = "logo" | "banner" | "website";

export interface Memo {
  /** What each item was set to and read back: a file's sha256, or the website. A rerun skips a match. */
  saved?: Partial<Record<Item, string>>;
  /** The website the editor showed at check: already right needs no save. */
  liveWebsite?: string;
}

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

/** What the editor shows now. Image URLs change with every upload. */
export interface EditorState {
  logo: string | null;
  banner: string | null;
  website: string;
}

export type Change =
  | { item: "logo"; file: string }
  | { item: "banner"; file: string }
  | { item: "website"; url: string };

export interface BrandPageInput {
  companyId: string;
  /** One change, saved and read back; null opens the editor as admin and reads it. */
  change: Change | null;
}

export interface BrandPageOutput {
  state: EditorState;
  /** "saved": changed and read back; "same": already so, nothing saved; "read": no change asked. */
  outcome: "saved" | "same" | "read";
}

/** LinkedIn's guide: logo 300x300, cover 1128x191. Ours: near their shapes, under 8 MB. */
export const RULES: Record<"logo" | "banner", ImageRule> = {
  logo: { what: "logo", minWidth: 300, minHeight: 300, aspect: [0.9, 1.1], maxBytes: 8e6 },
  banner: { what: "banner", minWidth: 1128, minHeight: 191, aspect: [3.5, 6.5], maxBytes: 8e6 },
};

const SAVE: Hints = { id: "org-page-edit-modal-banner__save-button" };
const NO_THANKS: Hints = { role: "button", name: "No thanks" };
const SHARE_DIALOG: Hints = { role: "dialog", name: "Share your page edits" };
const SHARE_DISMISS: Hints = {
  css: '[role=dialog]:has-text("Share") button:is([aria-label*="Dismiss" i], [aria-label*="Close" i])',
};
const LOGO_INPUT = "#organization-logo-field";
const LOGO_BUTTON: Hints[] = ["Upload logo", "Edit logo", "Change logo"].map((name) => ({
  role: "button",
  name,
}));
const BACKGROUND_MENU: Hints = { role: "button", name: "Edit background" };
// Menu items match by text: a css :text-matches on the item missed it (2026-10-05).
const COVER_EDIT: Hints[] = [{ text: "Edit cover image" }, { text: "Change cover image" }];
const COVER_UPLOAD: Hints[] = [{ text: "Upload cover image" }, { text: "Add cover image" }];
const COVER_DIALOG: Hints = { role: "dialog", name: "Cover Image" };
const COVER_INPUT = "#org-image-editor__change-photo-input";
const COVER_CHANGE: Hints[] = [
  { css: '[role=dialog] button:has-text("Change image")' },
  { css: '[role=dialog] button:has-text("Upload")' },
];
// In the dialog only: the Page's own Save is a button "Save" too.
const DIALOG_APPLY: Hints[] = [
  { css: '[role=dialog] button:has-text("Apply")' },
  { css: '[role=dialog] button:text-is("Save")' },
];
const WEBSITE: Hints = { id: "organization-website-field" };
const NO_WEBSITE = 'input[type=checkbox][id*="website" i]';
const SAVE_ERROR = /something went wrong|couldn.t (save|update)|try again|failed/i;

/** The page's own, for the banner read (no DOM lib here). */
declare const getComputedStyle: (e: unknown) => { backgroundImage: string };

/** Same site to a person: scheme, `www.`, case and a trailing slash aside. */
export const sameUrl = (a: string, b: string) => {
  const norm = (u: string) =>
    u
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/+$/, "");
  return norm(a) === norm(b);
};

const editor = (id: string, tab: "info" | "details") =>
  `https://www.linkedin.com/company/${id}/admin/edit/?editPageActiveTab=${tab}`;
const READY = { info: LOGO_INPUT, details: "#organization-website-field" } as const;
const WALL = /linkedin\.com\/(authwall|login|uas\/|checkpoint)/;

/**
 * Open an editor tab, signed in, as admin. A Google sign-in once left LinkedIn a
 * session-only cookie, so a fresh browser met /authwall, sometimes after the page
 * first loaded: one sign-in, then a person. Leaving a dirty form says yes to
 * "leave site?": a reopen means the edit is given up.
 */
async function openEditor(fp: FlowPage, id: string, tab: "info" | "details"): Promise<void> {
  const leave = (d: Dialog) => void (d.type() === "beforeunload" ? d.accept() : d.dismiss());
  fp.page.on("dialog", leave);
  try {
    await fp.open(editor(id, tab));
    if (WALL.test(fp.url()) || (await fp.waitForUrl(WALL, 4_000))) {
      if ((await fp.signIn("linkedin")) !== "signed-in")
        fp.human("LinkedIn is signed out and the one sign-in try failed");
      await fp.open(editor(id, tab));
      if (WALL.test(fp.url())) fp.human(`LinkedIn still walls ${fp.url()} after signing in`);
    }
    const ready = await fp.page
      .locator(READY[tab])
      .waitFor({ state: "attached", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (ready) return;
    if (!/\/admin\//.test(fp.url()))
      fp.human(`LinkedIn sent the editor to ${fp.url()}: this account is not an admin of ${id}`);
    fp.human(`the Page editor's ${tab} tab never loaded at ${fp.url()}`);
  } finally {
    fp.page.off("dialog", leave);
  }
}

/** The logo's and cover's image URLs on the info tab, null when the Page has none. */
async function readImages(fp: FlowPage): Promise<Pick<EditorState, "logo" | "banner">> {
  const first = (css: string) => fp.page.locator(css).first();
  const logo = await first("img.org-logo-input__logo-image")
    .getAttribute("src", { timeout: 2_000 })
    .catch(() => null);
  const bg = await first(".org-cropped-image__cover-image")
    .evaluate((e) => getComputedStyle(e).backgroundImage, undefined, { timeout: 2_000 })
    .catch(() => "");
  return { logo: logo || null, banner: /url\("?([^")]+)"?\)/.exec(bg)?.[1] ?? null };
}

/** The website once it settles: it fills in a beat after the tab loads. Empty when none is set. */
async function readWebsite(fp: FlowPage): Promise<string> {
  const field = fp.page.locator(READY.details);
  let last = await field.inputValue();
  for (let i = 0; i < 16; i++) {
    await fp.wait(500);
    const now = await field.inputValue();
    if (now && now === last) return now;
    last = now;
  }
  return last;
}

/** Wait for an image's URL to move off `before`: the save landed. */
async function readBack(
  fp: FlowPage,
  id: string,
  key: "logo" | "banner",
  before: string | null,
): Promise<EditorState[typeof key]> {
  for (let i = 0; i < 15; i++) {
    const now = (await readImages(fp))[key];
    if (now && now !== before) return now;
    await fp.wait(1_000);
  }
  // The editor can keep its old preview: the saved Page is the truth.
  await openEditor(fp, id, "info");
  const now = (await readImages(fp))[key];
  if (!now || now === before) fp.human(`LinkedIn still shows the old ${key} after saving it`);
  return now;
}

/** The first of `options` on the page (each given `withinMs` in turn), or null. */
async function shown(fp: FlowPage, options: Hints[], withinMs = 0): Promise<Hints | null> {
  for (const h of options) if (await fp.has(h, withinMs || undefined)) return h;
  return null;
}

/** Close "Share your page edits" without sharing: No thanks, its dismiss, then Escape. */
async function declineShare(fp: FlowPage, withinMs = 10_000): Promise<void> {
  if (await fp.has(NO_THANKS, withinMs))
    return fp.act({ kind: "click" }, NO_THANKS, { goal: "skip the share-your-edits post" });
  if (await fp.has(SHARE_DISMISS))
    return fp.act({ kind: "click" }, SHARE_DISMISS, { goal: "close the share-your-edits post" });
  if (await fp.has(SHARE_DIALOG)) await fp.page.keyboard.press("Escape");
}

async function saveError(fp: FlowPage): Promise<string | null> {
  const toasts = await fp.page
    .locator(".artdeco-toast-item")
    .allInnerTexts()
    .catch(() => []);
  return toasts.find((t) => SAVE_ERROR.test(t))?.trim() ?? null;
}

/** Save once the edit registered, decline the share post, retry once on an error toast. */
async function save(fp: FlowPage, what: string): Promise<void> {
  if (!(await fp.has(SAVE, 10_000)))
    fp.human(`no Save after setting ${what}: LinkedIn did not take the edit`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fp.act({ kind: "click" }, SAVE, { goal: `save ${what}`, irreversible: true });
    } catch (err) {
      if (!(await fp.has(NO_THANKS, 5_000))) throw err;
    }
    await declineShare(fp);
    const error = await saveError(fp);
    if (!(await fp.has(SAVE, 3_000))) return;
    if (!error) break;
  }
  fp.human(`LinkedIn still shows Save after saving ${what}`);
}

async function setLogo(fp: FlowPage, id: string, file: string, before: EditorState) {
  // The hidden input when it is there; the button's file chooser otherwise.
  const target = (await fp.page.locator(LOGO_INPUT).count())
    ? { id: LOGO_INPUT.slice(1) }
    : await shown(fp, LOGO_BUTTON);
  if (!target) fp.human("no logo input or upload button on the editor");
  await fp.act({ kind: "upload", files: [file] }, target, { goal: "upload the logo" });
  // Some editors crop first.
  const crop = await shown(fp, DIALOG_APPLY, 1_500);
  if (crop) await fp.act({ kind: "click" }, crop, { goal: "apply the logo crop" });
  await save(fp, "the logo");
  return { ...before, logo: await readBack(fp, id, "logo", before.logo) };
}

async function setBanner(fp: FlowPage, id: string, file: string, before: EditorState) {
  if (await fp.has(BACKGROUND_MENU, 5_000))
    await fp.act({ kind: "click" }, BACKGROUND_MENU, { goal: "open the banner menu" });
  const edit = await shown(fp, COVER_EDIT, 3_000);
  const upload = edit ? null : await shown(fp, COVER_UPLOAD);
  if (edit) {
    await fp.act({ kind: "click" }, edit, { goal: "open the cover editor" });
    if (!(await fp.has(COVER_DIALOG, 10_000))) fp.human("the cover editor never opened");
    const target = (await fp.page.locator(COVER_INPUT).count())
      ? { id: COVER_INPUT.slice(1) }
      : await shown(fp, COVER_CHANGE);
    if (!target) fp.human("the cover editor has no way to change the image");
    await fp.act({ kind: "upload", files: [file] }, target, { goal: "upload the banner" });
  } else if (upload) {
    // No cover yet: the item opens the file chooser, the editor comes after.
    await fp.act({ kind: "upload", files: [file] }, upload, { goal: "upload the banner" });
  } else fp.human("no way to change the banner: the menu has no cover image item");
  const apply = await shown(fp, DIALOG_APPLY, 10_000);
  if (apply) await fp.act({ kind: "click" }, apply, { goal: "apply the banner" });
  // Apply shows "Saving" until the upload lands.
  for (let i = 0; i < 45 && (await fp.has(COVER_DIALOG)); i++) await fp.wait(1_000);
  if (await fp.has(COVER_DIALOG)) {
    const error = await saveError(fp);
    fp.human(`the cover editor never finished: ${error ?? "still open after 45s"}`);
  }
  // Apply can save the cover itself ("Cover image updated", then the share dialog): Save only if still dirty.
  await declineShare(fp, 3_000);
  if (await fp.has(SAVE, 3_000)) await save(fp, "the banner");
  return { ...before, banner: await readBack(fp, id, "banner", before.banner) };
}

async function setWebsite(fp: FlowPage, id: string, url: string, before: EditorState) {
  const box = fp.page.locator(NO_WEBSITE);
  if ((await box.count()) && (await box.isChecked()))
    await box.uncheck({ force: true }).catch(() => fp.human('can\'t untick "no website"'));
  await fp.act({ kind: "fill", value: url }, WEBSITE, { goal: "set the website" });
  await save(fp, "the website");
  await openEditor(fp, id, "details");
  const after = await readWebsite(fp);
  if (!sameUrl(after, url)) fp.human(`website reads "${after}" after saving ${url}`);
  return { ...before, website: after };
}

const brandPageFlow = defineFlow<BrandPageInput, BrandPageOutput>({
  site: "linkedin",
  name: "brand-page",
  // William's account signs in by Google: its session lives in that profile.
  profile: "provider",
  async run(fp, { companyId: id, change }) {
    await openEditor(fp, id, "info");
    const images = await readImages(fp);
    await openEditor(fp, id, "details");
    const state: EditorState = { ...images, website: await readWebsite(fp) };
    if (!change) return { state, outcome: "read" };
    if (change.item === "website") {
      if (sameUrl(state.website, change.url)) return { state, outcome: "same" };
      return { state: await setWebsite(fp, id, change.url, state), outcome: "saved" };
    }
    await openEditor(fp, id, "info");
    const after =
      change.item === "logo"
        ? await setLogo(fp, id, change.file, state)
        : await setBanner(fp, id, change.file, state);
    return { state: after, outcome: "saved" };
  },
});

/** Each item the plan sets, with what marks it done: a file's sha256, or the URL. */
export function wanted(plan: Plan): { change: Change; mark: string }[] {
  const sha = (f: string) =>
    /^[a-z][a-z0-9+.-]*:\/\//i.test(f)
      ? f
      : createHash("sha256").update(readFileSync(f)).digest("hex");
  const out: { change: Change; mark: string }[] = [];
  if (plan.logoFile)
    out.push({ change: { item: "logo", file: plan.logoFile }, mark: sha(plan.logoFile) });
  if (plan.bannerFile)
    out.push({ change: { item: "banner", file: plan.bannerFile }, mark: sha(plan.bannerFile) });
  if (plan.website)
    out.push({ change: { item: "website", url: plan.website }, mark: plan.website });
  return out;
}

/** What still needs a save: not saved by this run, and not already live. */
export function todo(plan: Plan, memo: Memo) {
  return wanted(plan).filter(({ change, mark }) => {
    if (memo.saved?.[change.item] === mark) return false;
    return !(
      change.item === "website" &&
      memo.liveWebsite &&
      sameUrl(memo.liveWebsite, change.url)
    );
  });
}

const describe = (c: Change) => (c.item === "website" ? `website ${c.url}` : `${c.item} ${c.file}`);

const check: Step<"check"> = {
  name: "check",
  async run({ fx, deps, plan, memo }) {
    const problems = [
      plan.logoFile && imageProblem(plan.logoFile, RULES.logo),
      plan.bannerFile && imageProblem(plan.bannerFile, RULES.banner),
    ].filter((p): p is string => Boolean(p));
    if (problems.length) throw new Error(problems.join("; "));
    const { state } = await fx.run("browser read the Page editor", () =>
      deps.browser.run(brandPageFlow, { companyId: plan.companyId, change: null }),
    );
    memo.liveWebsite = state.website;
    const left = todo(plan, memo).map((t) => t.change.item);
    return done(
      `admin of ${plan.companyId}, website "${state.website}", ` +
        `${state.logo ? "has" : "no"} logo, ${state.banner ? "has" : "no"} banner; ` +
        (left.length ? `to set: ${left.join(", ")}` : "nothing to set"),
    );
  },
};

const brand: Step<"brand"> = {
  name: "brand",
  irreversible: true,
  harmless: (plan, memo) => todo(plan, memo).length === 0,
  async run({ fx, deps, plan, memo, gate }) {
    if (!wanted(plan).length) return skipped("no logo, banner or website given");
    const left = todo(plan, memo);
    if (!left.length) return skipped("already set");
    const answer = gate(
      "send",
      `Set LinkedIn Page ${plan.companyId}: ${left.map((t) => describe(t.change)).join("; ")}?`,
    );
    if (!answer.approved) return rejected(answer.note ?? "not changed");
    const proof: string[] = [];
    for (const { change, mark } of left) {
      const { outcome } = await fx.run(`browser set the ${change.item}`, () =>
        deps.browser.run(brandPageFlow, { companyId: plan.companyId, change }),
      );
      // Kept per item: a later item failing does not redo this one.
      memo.saved = { ...memo.saved, [change.item]: mark };
      proof.push(`${change.item} ${outcome === "same" ? "already set" : "saved, read back"}`);
    }
    return done(proof.join("; "));
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "linkedin-page-branding",
  description:
    "Set a LinkedIn company Page's logo, banner and website from its admin editor: files checked first, one save each, each read back, the share-your-edits post declined.",
  plan: planSchema,
  steps: [check, brand],
  emptyMemo: () => ({}),
});
