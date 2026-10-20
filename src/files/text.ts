/**
 * A doc's text, read once when it is added (designs/2026-10-20-files.md): PDF by `unpdf`,
 * DOCX by `mammoth`, plain text and Markdown as is. Images have none (no OCR).
 */
import type { FileType } from "./store.js";

/** A resume or transcript is a few thousand chars; this only stops a runaway file. */
export const TEXT_MAX_CHARS = 200_000;

/** The text in a file of this type, trimmed; null when it has none (an image, a scan). */
export async function textOf(type: FileType, data: Buffer): Promise<string | null> {
  let text: string;
  switch (type) {
    case "application/pdf": {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(data));
      text = (await extractText(pdf, { mergePages: true })).text;
      break;
    }
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      const { default: mammoth } = await import("mammoth");
      text = (await mammoth.extractRawText({ buffer: data })).value;
      break;
    }
    case "text/plain":
    case "text/markdown":
      text = data.toString("utf8");
      break;
    default:
      return null;
  }
  const out = text.replace(/\r\n/g, "\n").trim();
  return out ? out.slice(0, TEXT_MAX_CHARS) : null;
}
