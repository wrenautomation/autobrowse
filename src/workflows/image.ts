/**
 * An image file checked before an uploader sees it: the type, size and shape a
 * site would refuse or crop badly. Read from the file's header, no decoder.
 */
import { existsSync, readFileSync, statSync } from "node:fs";

export interface ImageInfo {
  type: "png" | "jpeg" | "gif";
  width: number;
  height: number;
}

/** Type and pixel size from the header; null when it is none of the three. */
export function imageInfo(buf: Buffer): ImageInfo | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47)
    return { type: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF")
    return { type: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1] ?? 0;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // A frame header (SOF0 to SOF15, less DHT, JPG and DAC) carries the size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { type: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

export interface ImageRule {
  /** "logo": named in the problem. */
  what: string;
  minWidth: number;
  minHeight: number;
  /** Width over height, inclusive. */
  aspect: readonly [number, number];
  maxBytes: number;
}

/** What is wrong with the file for this rule, or null. A remote ref (s3://, https://) is checked where it lands. */
export function imageProblem(path: string, rule: ImageRule): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  if (!existsSync(path)) return `${rule.what}: no file at ${path}`;
  const bytes = statSync(path).size;
  if (bytes > rule.maxBytes)
    return `${rule.what}: ${(bytes / 1e6).toFixed(1)} MB, over ${rule.maxBytes / 1e6} MB`;
  const info = imageInfo(readFileSync(path));
  if (!info) return `${rule.what}: ${path} is not a PNG, JPEG or GIF`;
  const { width, height } = info;
  if (width < rule.minWidth || height < rule.minHeight)
    return `${rule.what}: ${width}x${height}, under ${rule.minWidth}x${rule.minHeight}`;
  const ratio = width / height;
  if (ratio < rule.aspect[0] || ratio > rule.aspect[1])
    return `${rule.what}: ${width}x${height} is ${ratio.toFixed(2)}:1, wants ${rule.aspect[0]} to ${rule.aspect[1]}`;
  return null;
}
