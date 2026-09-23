/**
 * A browser leg that uploads a file needs it on this machine. A caller on
 * another machine (wren's worker on Lambda) has only a URL: a signed GET on
 * its media bucket. `withLocalFile` fetches that URL to a temp file for the
 * run and removes it after. A plain path is used as is.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Instagram takes up to 1 GB (a 60 min video); TikTok up to 4 GB. The box has room for one. */
const MAX_BYTES = 4 * 1024 ** 3;

const isUrl = (s: string) => /^https?:\/\//i.test(s);

/** The file's extension from the URL's path (the query of a signed URL is not part of it). */
export function extOf(url: string): string {
  try {
    return extname(new URL(url).pathname).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Run `fn` with `input[field]` as a local path. A URL is downloaded first
 * and deleted when `fn` settles; never logged, since a signed URL is a bearer.
 */
export async function withLocalFile<T>(
  input: Record<string, unknown>,
  field: string,
  fn: (input: Record<string, unknown>) => Promise<T>,
  o: { fetch?: typeof fetch; maxBytes?: number } = {},
): Promise<T> {
  const src = input[field];
  if (typeof src !== "string" || !isUrl(src)) return fn(input);
  const res = await (o.fetch ?? fetch)(src);
  if (!res.ok || !res.body) throw new Error(`${field}: the media URL answered ${res.status}`);
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > (o.maxBytes ?? MAX_BYTES)) throw new Error(`${field}: ${size} bytes is too big`);
  const dir = await mkdtemp(join(tmpdir(), "upload-"));
  const path = join(dir, `media${extOf(src)}`);
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path));
    return await fn({ ...input, [field]: path });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
