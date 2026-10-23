/**
 * Every account ours follows on TikTok, read off the signed-in profile (no public API lists
 * follows). `/profile` sends the page to `/@<us>`; the header's `following-count` opens the
 * Following dialog, whose rows are `/@<handle>` links (name, then handle). The flow scrolls the
 * dialog's list box until it holds the count or brings nothing new. A count of 0 answers an empty
 * list without the dialog. Reads only.
 *
 * Mapped 2026-10-22 in explore on the tiktok profile (ours follows nobody yet, so the rows were
 * mapped on a public account's dialog: `section[role=dialog]`, box `[class*=DivUserListContainer]`).
 */
import { defineFlow } from "../flow.js";
import { countOf, dialogFollowing, type Followed } from "./dialog-following.js";

const WEB = "https://www.tiktok.com";
const RENDER_MS = 15_000;
const COUNT = "[data-e2e=following-count]";
const DIALOG = `[...document.querySelectorAll("section[role=dialog]")].find((x) => /Following/.test(x.innerText))`;

/** One dialog row: its `/@<handle>` href and its text (name, then handle). */
export function followedOfTiktok(href: string, text: string): Followed | null {
  const username = /^\/@([\w.]{1,40})\/?$/.exec(href)?.[1];
  if (!username) return null;
  const first = text.split("\n")[0]?.trim() ?? "";
  return { username, name: first && first !== username ? first : null };
}

export const tiktokFollowing = defineFlow<
  { max?: number },
  { data: Followed[]; meta: { result_count: number; listed: number | null } }
>({
  site: "tiktok",
  name: "following",
  async run(fp, { max }) {
    await fp.open(`${WEB}/profile`);
    if (!(await fp.has({ css: COUNT }, RENDER_MS))) {
      if (/\/login\b/.test(fp.url()))
        return fp.human("TikTok is signed out on this profile: `autobrowse login tiktok`");
      return fp.human(`no Following count on ${fp.url()}`);
    }
    const listed = countOf(await fp.read({ css: COUNT }));
    if (listed === 0) return { data: [], meta: { result_count: 0, listed } };
    await fp.act({ kind: "click" }, { css: COUNT }, { goal: "open our Following list" });
    const data = await dialogFollowing(fp, {
      dialog: DIALOG,
      box: "[class*=DivUserListContainer]",
      row: followedOfTiktok,
      max,
      listed,
    });
    if (!data.length)
      return fp.human(`no accounts read in TikTok's Following dialog (${fp.url()})`);
    return { data, meta: { result_count: data.length, listed } };
  },
});
