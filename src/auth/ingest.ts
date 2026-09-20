/**
 * Credentials typed somewhere that is not a shell argument, a chat or a
 * log: the clipboard, or a scratch file that is shredded after. One line
 * per site, `site email password [authenticator key]`, `#` comments;
 * `paste` takes the same line without the site. Nothing here prints a value.
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { type CredentialInput, type CredentialStore, credentialSchema } from "./credentials.js";

export interface IngestLine {
  site: string;
  cred: CredentialInput;
}

/** Parse the lines; a bad line is reported by number, never by content. */
export function parseCredentialLines(text: string, site?: string): IngestLine[] {
  const out: IngestLine[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split(/\s+/);
    const [name, username, password, ...rest] = site ? [site, ...parts] : parts;
    if (!name || !username || !password)
      throw new Error(
        `line ${i + 1}: expected \`${site ? "" : "site "}email password [authenticator key]\``,
      );
    const cred = credentialSchema.safeParse({
      username,
      password,
      ...(rest.length ? { totpSecret: rest.join("") } : {}),
    });
    if (!cred.success)
      throw new Error(`line ${i + 1}: ${cred.error.issues[0]?.message ?? "bad line"}`);
    out.push({ site: name, cred: cred.data });
  });
  return out;
}

/** Store every line; returns the site names stored. */
export async function ingest(store: CredentialStore, lines: IngestLine[]): Promise<string[]> {
  for (const l of lines) await store.put(l.site, l.cred);
  return lines.map((l) => l.site);
}

/** The clipboard's text, then the clipboard emptied so the value does not linger. */
export function takeClipboard(): string {
  if (process.platform !== "darwin") throw new Error("clipboard ingest needs macOS (pbpaste)");
  const text = execFileSync("pbpaste", { encoding: "utf8" });
  execFileSync("pbcopy", { input: "" });
  return text;
}

/** The file's text, then the file overwritten with zeros and removed. */
export function takeFile(path: string): string {
  const text = readFileSync(path, "utf8");
  const size = statSync(path).size;
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.alloc(size), 0, size, 0);
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
  return text;
}
