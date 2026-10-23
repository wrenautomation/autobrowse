/**
 * Every account ours follows on Threads, read off the signed-in profile: the API lists no
 * follows. Threads signs in through Instagram, so the flow runs on the instagram profile. The
 * nav's Profile link names us (`/@<us>`); the header's "N followers" opens a dialog with
 * Followers, Following and Mutual tabs. Each Following row is a `/@<handle>` link (handle only)
 * in a box with the handle, the name and a Follow button. Reads only.
 *
 * Mapped 2026-10-22 in explore (ours follows nobody yet; rows mapped on a public account).
 */
import { defineFlow } from "../flow.js";
import { countOf, dialogFollowing, type Followed } from "./dialog-following.js";

const WEB = "https://www.threads.com";
const RENDER_MS = 15_000;
const SETTLE_MS = 1_000;
const BUTTON = /^(follow|following|follow back|requested)$/i;

/** One dialog row: its `/@<handle>` href and its box's text (handle, name, button). */
export function followedOfThreads(href: string, text: string): Followed | null {
  const username = /^\/@([\w.]{1,40})\/?$/.exec(href)?.[1];
  if (!username) return null;
  const name = text.split("\n").map((l) => l.trim())[1] ?? "";
  return { username, name: name && !BUTTON.test(name) && name !== username ? name : null };
}

export const threadsFollowing = defineFlow<
  { max?: number },
  { data: Followed[]; meta: { result_count: number; listed: number | null } }
>({
  site: "instagram",
  name: "threads-following",
  async run(fp, { max }) {
    await fp.open(`${WEB}/`);
    let me: string | null = null;
    for (let n = 0; n < RENDER_MS / SETTLE_MS && !me; n++) {
      if (/\/login\b/.test(fp.url()))
        return fp.human("Threads is signed out on this profile: `autobrowse login instagram`");
      const href = await fp.page.evaluate<string | null>(
        `[...document.querySelectorAll('a[href^="/@"]')].find((a) => a.innerText.trim() === "Profile")?.getAttribute("href") ?? null`,
      );
      me = (href && /^\/@([\w.]{1,40})$/.exec(href)?.[1]) || null;
      if (!me) await fp.wait(SETTLE_MS);
    }
    if (!me) return fp.human("could not tell which Threads account this profile is signed in as");
    await fp.open(`${WEB}/@${me}`);
    await fp.act(
      { kind: "click" },
      { text: "/^[\\d.,]+[KMB]? followers?$/i" },
      { goal: "open our followers dialog" },
    );
    const tab = { role: "tab", name: "/^Following/" };
    if (!(await fp.has(tab, RENDER_MS))) return fp.human(`no Following tab on ${fp.url()}`);
    await fp.act({ kind: "click" }, tab, { goal: "show who we follow" });
    const listed = countOf((await fp.read(tab)).replace(/^Following\s*/i, ""));
    if (listed === 0) return { data: [], meta: { result_count: 0, listed } };
    await fp.wait(SETTLE_MS);
    const data = await dialogFollowing(fp, {
      dialog: `document.querySelector("[role=dialog]")`,
      row: followedOfThreads,
      max,
      listed,
    });
    if (!data.length) return fp.human(`no accounts read in Threads' Following tab (${fp.url()})`);
    return { data, meta: { result_count: data.length, listed } };
  },
});
