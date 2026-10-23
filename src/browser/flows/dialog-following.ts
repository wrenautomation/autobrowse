/**
 * A Following list shown in a dialog (TikTok, Threads): read its `/@<handle>` rows, scroll its
 * list box, until it holds the profile's own count, `max`, or a few scrolls bring nothing new.
 */
import type { FlowPage } from "../flow.js";
import { scrollCollect } from "../scroll-collect.js";

export interface Followed {
  username: string;
  name: string | null;
}

/** "82", "1.2K", "3M" (a "followers" word after is fine) as a number; null when unreadable. */
export function countOf(s: string): number | null {
  const m = /^([\d.,]+)\s*([KMB])?\b/i.exec(s.trim());
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, ""));
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? "").toUpperCase()] ?? 1;
  return Number.isFinite(n) ? Math.round(n * mult) : null;
}

export interface DialogFollowing {
  /** A JS expression for the dialog element (null when it is not open). */
  dialog: string;
  /** CSS for the list box that scrolls, inside the dialog; omitted: the first box that scrolls. */
  box?: string;
  /** One row from its link's href and its row's text (the largest box around that one handle). */
  row: (href: string, text: string) => Followed | null;
  max?: number | undefined;
  /** The profile's own count: collection ends when it holds this many. */
  listed: number | null;
}

export async function dialogFollowing(fp: FlowPage, o: DialogFollowing): Promise<Followed[]> {
  const cap = Math.min(Math.max(1, o.max ?? 1000), 1000);
  const read = `(() => {
    const d = ${o.dialog};
    if (!d) return [];
    return [...d.querySelectorAll('a[href^="/@"]')].filter((a) => a.innerText.trim()).map((a) => {
      const href = a.getAttribute("href") || "";
      const handles = (el) => new Set([...el.querySelectorAll('a[href^="/@"]')].map((x) => x.getAttribute("href"))).size;
      let r = a;
      while (r.parentElement && r.parentElement !== d && handles(r.parentElement) <= 1) r = r.parentElement;
      return [href, r.innerText || ""];
    });
  })()`;
  const scroll = `(() => {
    const d = ${o.dialog};
    if (!d) return;
    const box = ${o.box ? `d.querySelector(${JSON.stringify(o.box)})` : `[...d.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY))`};
    if (box) box.scrollTop = box.scrollHeight;
  })()`;
  const { rows } = await scrollCollect(fp, {
    read: async () =>
      ((await fp.page.evaluate<[string, string][]>(read).catch(() => [])) ?? [])
        .map(([href, text]) => o.row(href, text))
        .filter((f): f is Followed => f !== null),
    key: (f) => f.username.toLowerCase(),
    max: Math.min(cap, o.listed ?? cap),
    scroll: async () => {
      await fp.page.evaluate(scroll).catch(() => undefined);
    },
    settleMs: 1_500,
  });
  return rows;
}
