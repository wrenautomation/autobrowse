/**
 * A file the page links to, fetched with the page's own sign-in (the
 * context's cookies): what an in-page `fetch` download does, with no
 * script. Explore keeps it beside the session; a walk hands it to its
 * `download` dep.
 */
import type { Page } from "playwright";
import { type Hints, locate } from "./locate.js";

/** Bytes one download may bring, at most. */
export const MAX_DOWNLOAD = 50 * 1024 * 1024;

export interface Fetched {
  /** The file's name: the server's, else the URL's last part. */
  name: string;
  mimeType: string;
  buffer: Buffer;
  url: string;
}

/** `url` (relative to the page), or the `href` of the element `hints` find. */
export async function fetchFile(
  page: Page,
  from: { url?: string | null; hints?: Hints | null },
): Promise<Fetched> {
  let href = from.url ?? null;
  if (!href && from.hints)
    href = await locate(page, from.hints).first().getAttribute("href", { timeout: 10_000 });
  if (!href) throw new Error("download: no URL, and the element has no href");
  const url = new URL(href, page.url()).toString();
  const res = await page.context().request.get(url, { timeout: 60_000 });
  if (!res.ok()) throw new Error(`download: ${res.status()} from ${new URL(url).pathname}`);
  const buffer = await res.body();
  if (buffer.length > MAX_DOWNLOAD)
    throw new Error(`download: ${buffer.length} bytes is over ${MAX_DOWNLOAD}`);
  const headers = res.headers();
  return {
    name: fileName(headers["content-disposition"], url),
    mimeType: (headers["content-type"] ?? "application/octet-stream").split(";")[0]?.trim() || "",
    buffer,
    url,
  };
}

/** The server's `filename`, else the URL path's last part; never a path. */
export function fileName(disposition: string | undefined, url: string): string {
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition ?? "")?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(disposition ?? "")?.[1];
  const last = new URL(url).pathname.split("/").at(-1) ?? "";
  const raw = star ? decoded(star.trim()) : (plain ?? decoded(last));
  const name = (raw ?? "").replace(/[/\\]/g, "_").replace(/^\.+/, "").trim();
  return name || "download";
}

const decoded = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
