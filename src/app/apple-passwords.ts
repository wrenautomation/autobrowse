/**
 * Accounts into Apple Passwords, already sorted: one row per login with its
 * address, password and authenticator, so every code sits under the right
 * name on every device iCloud syncs to. Passwords has no API: a CSV in a
 * private temp folder, its own File → Import, then the file is deleted.
 * Mapped 2026-09-25: File → "Import Passwords from File…" → sheet "Choose
 * File" → open panel. An import never replaces a login already there.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PasswordsRow {
  title: string;
  url: string;
  username: string;
  password: string;
  notes?: string;
  /** otpauth://totp/… for the login's authenticator. */
  otpauth?: string;
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Passwords' own export columns, so its import reads every one. */
export function passwordsCsv(rows: readonly PasswordsRow[]): string {
  const head = "Title,URL,Username,Password,Notes,OTPAuth";
  const lines = rows.map((r) =>
    [r.title, r.url, r.username, r.password, r.notes ?? "", r.otpauth ?? ""].map(cell).join(","),
  );
  return `${[head, ...lines].join("\n")}\n`;
}

export function otpauthUri(issuer: string, account: string, secret: string): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}

const osascript = (lines: string[]) =>
  new Promise<string>((res, rej) =>
    execFile(
      "osascript",
      lines.flatMap((l) => ["-e", l]),
      (err, stdout, stderr) =>
        // stderr names the step ("Can't get button …"); the command line itself is not repeated.
        err
          ? rej(
              new Error(`Passwords did not take the import: ${String(stderr).trim().slice(-300)}`),
            )
          : res(stdout),
    ),
  );

/** Write the rows to a 0600 file, run Passwords' import on it, delete it; what Passwords said back. */
export async function importIntoPasswords(
  rows: readonly PasswordsRow[],
  run: (lines: string[]) => Promise<string> = osascript,
): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Apple Passwords is macOS only");
  const dir = await mkdtemp(join(tmpdir(), "passwords-"));
  const file = join(dir, "accounts.csv");
  try {
    await writeFile(file, passwordsCsv(rows), { mode: 0o600 });
    const said = await run([
      'tell application "Passwords" to reopen',
      'tell application "Passwords" to activate',
      'tell application "System Events"',
      'tell process "Passwords"',
      "repeat 20 times",
      "if exists window 1 then exit repeat",
      "delay 0.3",
      "end repeat",
      "delay 0.5",
      // A sheet left open (an earlier import) goes first: its Cancel, else Escape.
      "repeat 4 times",
      "if (count of sheets of window 1) is 0 then exit repeat",
      'if exists button "Cancel" of sheet 1 of window 1 then',
      'click button "Cancel" of sheet 1 of window 1',
      'else if exists button "Not Now" of sheet 1 of window 1 then',
      'click button "Not Now" of sheet 1 of window 1',
      'else if exists button "Cancel" of splitter group 1 of sheet 1 of window 1 then',
      'click button "Cancel" of splitter group 1 of sheet 1 of window 1',
      "else",
      "key code 53",
      "end if",
      "delay 0.8",
      "end repeat",
      'click menu item "Import Passwords from File…" of menu "File" of menu bar 1',
      "delay 1.5",
      'click button "Choose File" of sheet 1 of window 1',
      // The open panel, then Go to Folder in it: each waited for, not guessed.
      "repeat 20 times",
      "if exists splitter group 1 of sheet 1 of window 1 then exit repeat",
      "delay 0.3",
      "end repeat",
      "delay 0.8",
      "repeat with i from 1 to 20",
      "if exists sheet 1 of sheet 1 of window 1 then exit repeat",
      'if i mod 6 is 1 then keystroke "g" using {command down, shift down}',
      "delay 0.4",
      "end repeat",
      // The path straight into its field; Return selects the file.
      `set value of text field 1 of sheet 1 of sheet 1 of window 1 to ${JSON.stringify(file)}`,
      "delay 0.8",
      "key code 36",
      "repeat 20 times",
      "if not (exists sheet 1 of sheet 1 of window 1) then exit repeat",
      "delay 0.3",
      "end repeat",
      "delay 0.8",
      'click button "Import" of splitter group 1 of sheet 1 of window 1',
      // "Passwords successfully imported 3 passwords. Do you want to delete …?"
      "repeat 30 times",
      "if exists sheet 1 of window 1 then",
      'if exists (first button of sheet 1 of window 1 whose name starts with "Delete") then exit repeat',
      "end if",
      "delay 0.5",
      "end repeat",
      // What Passwords says it did ("3 passwords imported"), then its button to close.
      'set out to ""',
      "if (count of sheets of window 1) > 0 then",
      "set out to value of static text 1 of sheet 1 of window 1",
      // "Do you want to delete accounts.csv?": yes (it is removed here after anyway).
      "repeat with b in (buttons of sheet 1 of window 1)",
      'if name of b starts with "Delete" then',
      "click b",
      "exit repeat",
      "end if",
      "end repeat",
      "end if",
      "return out",
      "end tell",
      "end tell",
    ]);
    return said.trim();
  } finally {
    // The passwords and seeds are on disk only for the seconds the import takes.
    await rm(dir, { recursive: true, force: true });
  }
}
