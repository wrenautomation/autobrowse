/**
 * A personal phone, linked through the Mac it is paired with. Two legs:
 *   in:  SMS and iMessages land in Messages' own database
 *        (~/Library/Messages/chat.db) once "Text Message Forwarding" is on
 *        for this Mac; we read it with the sqlite3 tool, never a driver.
 *   out: a note to the phone is an iMessage sent by Messages.app through
 *        AppleScript, so "tap Yes on your phone" reaches the person.
 * Local, no vendor. Twilio is the rented-number twin behind the same
 * `MessageReader`; `channels/phone.ts` turns the notifier into a Channel.
 *
 * The one thing that cannot be done from code: macOS asks once for Full
 * Disk Access (to read the database) and once for Automation of
 * Messages (to send). `phoneStatus` says which is missing and opens the pane.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message, MessageReader } from "../auth/codes.js";
import { render } from "../channels/render.js";
import type { Channel } from "../channels/types.js";

export interface PhoneOptions {
  /** The phone's number, E.164; the one text forwarding and iMessage know. */
  number: string;
  dbPath?: string;
  /** Run a read-only SQL against the database; JSON rows out. Defaults to the sqlite3 tool. */
  sql?: (query: string) => string;
  /** Send an iMessage. Defaults to Messages.app over AppleScript. */
  send?: (to: string, text: string) => void;
}

export const DEFAULT_DB = join(homedir(), "Library", "Messages", "chat.db");

/** Messages stores dates as nanoseconds since 2001-01-01. */
const APPLE_EPOCH_S = 978_307_200;

function sqlite(dbPath: string): (query: string) => string {
  return (query) => {
    const r = spawnSync("sqlite3", ["-readonly", "-json", dbPath, query], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`sqlite3: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    return r.stdout;
  };
}

/**
 * Newer macOS keeps the text only in `attributedBody`, a typedstream. The
 * string sits after the "NSString" class name: a 5-byte header, then a
 * length (one byte, or 0x81 + two little-endian bytes), then the bytes.
 */
export function textFromAttributedBody(hex: string): string | null {
  const buf = Buffer.from(hex, "hex");
  const at = buf.indexOf("NSString");
  if (at < 0) return null;
  let i = at + "NSString".length + 5;
  let len = buf[i] ?? 0;
  i += 1;
  if (len === 0x81) {
    len = (buf[i] ?? 0) | ((buf[i + 1] ?? 0) << 8);
    i += 2;
  }
  return buf.subarray(i, i + len).toString("utf8") || null;
}

/** Incoming SMS/iMessages newer than `since`, newest last. `inbox` is the phone's number and is only checked for shape. */
export function phoneReader(opts: PhoneOptions): MessageReader {
  const sql = opts.sql ?? sqlite(opts.dbPath ?? DEFAULT_DB);
  return {
    async recent(_inbox, since) {
      const sinceNs = (Math.floor(since.getTime() / 1000) - APPLE_EPOCH_S) * 1e9;
      const rows = JSON.parse(
        sql(
          `select h.id as sender, coalesce(m.text, '') as text, hex(m.attributedBody) as body, m.date as date
           from message m left join handle h on h.ROWID = m.handle_id
           where m.is_from_me = 0 and m.date > ${sinceNs}
           order by m.date desc limit 50`,
        ) || "[]",
      ) as Array<{ sender: string | null; text: string; body: string; date: number }>;
      return rows
        .map(
          (r): Message => ({
            from: r.sender ?? "",
            subject: "",
            text: r.text || textFromAttributedBody(r.body) || "",
            at: new Date((r.date / 1e9 + APPLE_EPOCH_S) * 1000),
          }),
        )
        .filter((m) => m.text);
    },
  };
}

function appleScriptSend(to: string, text: string): void {
  const script = [
    "on run argv",
    'tell application "Messages"',
    "set svc to 1st account whose service type = iMessage",
    "set who to participant (item 1 of argv) of svc",
    "send (item 2 of argv) to who",
    "end tell",
    "end run",
  ].flatMap((l) => ["-e", l]);
  const r = spawnSync("osascript", [...script, to, text], { encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`Messages.app: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
}

/** Send one note to the phone. */
export function phoneNotifier(opts: PhoneOptions): (text: string) => Promise<void> {
  const send = opts.send ?? appleScriptSend;
  return async (text) => {
    send(opts.number, text);
  };
}

export interface PhoneStatus {
  /** Messages' database can be read: text forwarding delivers here and Full Disk Access is granted. */
  read: boolean;
  /** Messages.app answered a harmless AppleScript (Automation permission). */
  send: boolean;
  /** What a person has to do once, when something is missing. */
  fix: string[];
}

/** Which legs work, and the one-time steps for the ones that do not. */
export function phoneStatus(dbPath = DEFAULT_DB): PhoneStatus {
  const fix: string[] = [];
  let read = false;
  try {
    accessSync(dbPath, constants.R_OK);
    sqlite(dbPath)("select 1");
    read = true;
  } catch {
    fix.push(
      "Reading SMS: System Settings → Privacy & Security → Full Disk Access → turn on the app this runs from (Terminal, iTerm, VS Code, ...). Then iPhone → Settings → Messages → Text Message Forwarding → this Mac on.",
    );
  }
  const probe = spawnSync(
    "osascript",
    ["-e", 'tell application "Messages" to get name of 1st account'],
    { encoding: "utf8" },
  );
  const send = probe.status === 0;
  if (!send)
    fix.push(
      "Sending to the phone: open Messages.app signed in to iMessage; the first send asks once to allow Automation of Messages. Say yes.",
    );
  return { read, send, fix };
}

/** Opens the Full Disk Access pane so the one click is one click. macOS only; elsewhere a no-op. */
export function openFullDiskAccessPane(): void {
  if (process.platform !== "darwin") return;
  spawnSync("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]);
}
