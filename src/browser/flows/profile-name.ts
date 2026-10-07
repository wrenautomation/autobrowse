/**
 * The account's display name, on sites whose API cannot set it. Mapped
 * 2026-10-07 in headless explore while renaming Wren's accounts to "Wren".
 * Only the display name: handles, usernames and profile links never change
 * here (footers and attribution link to them). Each leg reads the name back
 * and answers `{ before, name }`; a site that holds the change answers why.
 *
 * - Instagram: the name lives in Accounts Center (the old Edit profile page
 *   lost the field). Twice in 14 days.
 * - X: the Edit profile dialog on /settings/profile. The API's v1.1
 *   update_profile wants OAuth 1.0a; our token is OAuth 2.
 * - TikTok: Edit profile on the profile page, then a "Set nickname?"
 *   confirm. Once every 7 days; the page shows the old nickname for a few
 *   minutes after, so the lock line ("change it again after …") is the proof.
 * - Reddit: the Display name modal on new Reddit's /settings/profile.
 *
 * Facebook Page names are not here: the legacy settings iframe asks for the
 * password and Meta reviews it; "Wren" was refused as too broad (2026-10-07).
 */
import type { FlowPage } from "../flow.js";
import { defineFlow } from "../flow.js";
import type { Hints } from "../locate.js";

export interface ProfileNameInput {
  /** The new display name. */
  name: string;
}

export interface ProfileNameResult {
  before: string;
  name: string;
  /** Set when the site took the change but holds the name (a review, a lag). */
  note?: string;
}

const RENDER_MS = 15_000;

async function fieldValue(fp: FlowPage, css: string): Promise<string> {
  return (await fp.page.locator(css).first().inputValue()).trim();
}

/** The site's own words when a name cannot change right now. */
function lockLine(text: string): string | null {
  return (
    /[^\n]*(can only change your (nick)?name|change it again after|can't change it again)[^\n]*/i
      .exec(text)?.[0]
      ?.trim() ?? null
  );
}

export const instagramProfileName = defineFlow<ProfileNameInput, ProfileNameResult>({
  site: "instagram",
  name: "profile-name",
  async run(fp, { name }) {
    await fp.open("https://accountscenter.instagram.com/profiles/");
    await fp.act(
      { kind: "click" },
      { role: "link", name: "/ Instagram$/" },
      { goal: "open the Instagram profile in Accounts Center" },
    );
    await fp.act(
      { kind: "click" },
      { role: "link", name: "Name" },
      { goal: "open the name editor" },
    );
    const box: Hints = { role: "textbox", name: "Name" };
    if (!(await fp.has(box, RENDER_MS))) return fp.human("Accounts Center: no Name field");
    const before = (await fp.page.getByRole("textbox", { name: "Name" }).inputValue()).trim();
    if (before === name) return { before, name };
    await fp.act({ kind: "fill", value: name }, box, { goal: "type the new name" });
    const done: Hints = { role: "button", name: "Done" };
    if (!(await fp.has(done, 3_000))) {
      const said = lockLine(await fp.text());
      return fp.human(`Instagram will not take the name now${said ? `: ${said}` : ""}`);
    }
    await fp.act({ kind: "click" }, done, { goal: "save the new name", irreversible: true });
    // Done closes the dialog; a refusal keeps it open with the reason.
    for (let i = 0; i < 10; i++) {
      await fp.wait(1_000);
      if (!(await fp.has(box))) return { before, name };
    }
    return fp.human(`Instagram kept the name dialog open: ${(await fp.text()).slice(0, 300)}`);
  },
});

export const xProfileName = defineFlow<ProfileNameInput, ProfileNameResult>({
  site: "x",
  name: "profile-name",
  async run(fp, { name }) {
    await fp.open("https://x.com/settings/profile");
    const field = "input[name=displayName]";
    if (!(await fp.has({ css: field }, RENDER_MS))) return fp.human("X: no Edit profile dialog");
    const before = await fieldValue(fp, field);
    if (before === name) return { before, name };
    await fp.act({ kind: "fill", value: name }, { css: field }, { goal: "type the new name" });
    await fp.act(
      { kind: "click" },
      { testId: "Profile_Save_Button" },
      { goal: "save the profile", irreversible: true },
    );
    // Saving closes the dialog onto home; the account switcher carries the name.
    if (!(await fp.waitForUrl((u) => !u.includes("/settings/profile"), RENDER_MS)))
      return fp.human(`X kept the dialog open: ${(await fp.text()).slice(0, 300)}`);
    const shown = await fp.read({ testId: "SideNav_AccountSwitcher_Button" });
    if (!shown.startsWith(name)) return fp.human(`X shows "${shown}" after saving, not "${name}"`);
    return { before, name };
  },
});

export const tiktokProfileName = defineFlow<ProfileNameInput, ProfileNameResult>({
  site: "tiktok",
  name: "profile-name",
  async run(fp, { name }) {
    await fp.open("https://www.tiktok.com/profile");
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Edit profile" },
      { goal: "open the profile editor" },
    );
    const box: Hints = { role: "textbox", name: "Name" };
    if (!(await fp.has(box, RENDER_MS))) {
      // Inside the 7 days the field is plain text with the date it opens again.
      const said = lockLine(await fp.text());
      return fp.human(`TikTok will not take a nickname now${said ? `: ${said}` : ""}`);
    }
    const before = (await fp.page.getByRole("textbox", { name: "Name" }).inputValue()).trim();
    if (before === name) return { before, name };
    await fp.act({ kind: "fill", value: name }, box, { goal: "type the new nickname" });
    await fp.act({ kind: "click" }, { role: "button", name: "Save" }, { goal: "save the profile" });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Confirm" },
      { goal: "confirm the nickname (locks it for 7 days)", irreversible: true },
    );
    await fp.wait(3_000);
    // The page lags; the editor's lock line is what says TikTok took it.
    await fp.open("https://www.tiktok.com/profile");
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Edit profile" },
      { goal: "reopen the editor to read the lock" },
    );
    await fp.wait(2_000);
    const said = lockLine(await fp.text());
    if (await fp.has(box, 1_000))
      return fp.human("TikTok left the nickname editable after Confirm: the change did not take");
    return { before, name, ...(said ? { note: said } : {}) };
  },
});

export const redditProfileName = defineFlow<ProfileNameInput, ProfileNameResult>({
  site: "reddit",
  name: "profile-name",
  async run(fp, { name }) {
    await fp.open("https://www.reddit.com/settings/profile");
    const open: Hints = { role: "button", name: "Open modal to change setting: Display name" };
    const box: Hints = { role: "textbox", name: "Display name" };
    await fp.act({ kind: "click" }, open, { goal: "open the display name modal" });
    if (!(await fp.has(box, RENDER_MS))) return fp.human("Reddit: no Display name field");
    const before = (
      await fp.page.getByRole("textbox", { name: "Display name" }).inputValue()
    ).trim();
    if (before === name) return { before, name };
    await fp.act({ kind: "fill", value: name }, box, { goal: "type the new display name" });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Save" },
      { goal: "save the display name", irreversible: true },
    );
    await fp.wait(2_000);
    await fp.open("https://www.reddit.com/settings/profile");
    await fp.act({ kind: "click" }, open, { goal: "reopen the modal to read the name back" });
    if (!(await fp.has(box, RENDER_MS)))
      return fp.human("Reddit: no Display name field on read-back");
    const after = (
      await fp.page.getByRole("textbox", { name: "Display name" }).inputValue()
    ).trim();
    if (after !== name) return fp.human(`Reddit shows "${after}" after saving, not "${name}"`);
    return { before, name };
  },
});
