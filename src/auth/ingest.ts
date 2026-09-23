/**
 * Credentials typed somewhere that is not a shell argument, a chat or a
 * log: the clipboard, or a scratch file that is shredded after. One line
 * per site, `site email password [authenticator key]`, `#` comments;
 * `paste` takes the same line without the site. Nothing here prints a value.
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { type CredentialInput, type CredentialStore, credentialSchema } from "credvault";

export interface IngestLine {
  site: string;
  cred: CredentialInput;
}

/** Parse the lines; a bad line is reported by number, never by content. */
export function parseCredentialLines(text: string, site?: string): IngestLine[] {
  const out: IngestLine[] = [];
  const rows = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  // `paste` copied as separate lines (email, then password, then key): one credential.
  if (site && rows.length > 1 && rows.length <= 3 && rows.every((l) => !/\s/.test(l.trim())))
    text = rows.join(" ");
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split(/\s+/);
    const [name, username, password, ...rest] = site ? [site, ...parts] : parts;
    if (!name || !username || !password)
      throw new Error(
        `line ${i + 1}: expected \`${site ? "" : "site "}email password [authenticator key]\` (${parts.length} word${parts.length === 1 ? "" : "s"} found)`,
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

/**
 * Store every line; returns the site names stored. A line sets the login
 * (address, password, key) and keeps the rest of what the site already holds:
 * its handle, when the address is the handle's code inbox, when it was made,
 * recovery codes, passkeys.
 */
export async function ingest(store: CredentialStore, lines: IngestLine[]): Promise<string[]> {
  for (const l of lines) {
    const had = await store.get(l.site);
    if (!had) {
      await store.put(l.site, l.cred);
      continue;
    }
    const handle = had.codesInbox === l.cred.username && had.username !== l.cred.username;
    await store.put(l.site, {
      ...had,
      ...l.cred,
      ...(handle ? { username: had.username } : {}),
      ...(had.password && had.password !== l.cred.password
        ? { previousPassword: had.password }
        : {}),
      totpSecret: l.cred.totpSecret ?? had.totpSecret,
    });
  }
  return lines.map((l) => l.site);
}

/**
 * The clipboard's text, and a `clear` to empty it once the value is stored:
 * a failed parse leaves it, so fixing the line is not copying it again.
 */
export function readClipboard(): { text: string; clear: () => void } {
  if (process.platform !== "darwin") throw new Error("clipboard ingest needs macOS (pbpaste)");
  const text = execFileSync("pbpaste", { encoding: "utf8" });
  if (!text.trim())
    throw new Error(
      "the clipboard is empty: copy `email password [authenticator key]`, then rerun",
    );
  return { text, clear: () => execFileSync("pbcopy", { input: "" }) };
}

/** `creds paste <site>`: the clipboard's one credential stored under `site`, then the clipboard emptied. */
export async function pasteCredential(store: CredentialStore, site: string): Promise<string> {
  const clip = readClipboard();
  const lines = parseCredentialLines(clip.text, site);
  if (lines.length !== 1)
    throw new Error(
      `the clipboard holds ${lines.length} credential lines; ${site} takes one: \`email password [authenticator key]\``,
    );
  await ingest(store, lines);
  clip.clear();
  return site;
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
