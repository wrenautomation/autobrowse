/** The explore command grammar: every command as a zod schema, which ones only look, which cannot batch, and the hints a command names turned into locator hints. */
import { z } from "zod";
import { desktopOpSchema } from "../desktop/types.js";
import type { LocatorHints } from "../recorder/types.js";

const hintsSchema = z.object({
  tag: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  placeholder: z.string().nullable().optional(),
  id: z.string().nullable().optional(),
  testId: z.string().nullable().optional(),
  href: z.string().nullable().optional(),
  inputType: z.string().nullable().optional(),
  css: z.string().nullable().optional(),
  nth: z.number().int().nonnegative().nullable().optional(),
  /** Inside an iframe: its selector chain from the page, as `aria` names it. */
  frame: z.string().nullable().optional(),
  /** A number from the last `marks` picture, in place of the rest: the act journals its hints. */
  mark: z.number().int().positive().optional(),
});

/** What an act points at: the same hints a flow uses (`css` and `nth` included). */
export const targetSchema = z.object({ hints: hintsSchema });

export const commandSchema = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("open"), url: z.string().url() }),
  targetSchema.extend({
    cmd: z.literal("click"),
    goal: z.string().optional(),
    /** A point inside the element from its top-left (a canvas, a captcha picture). */
    at: z.object({ x: z.number(), y: z.number() }).optional(),
  }),
  targetSchema.extend({ cmd: z.literal("fill"), value: z.string(), goal: z.string().optional() }),
  /** Press at `from`, carry to `to` (points inside the element from its top-left): a slider, a captcha piece. */
  targetSchema.extend({
    cmd: z.literal("drag"),
    from: z.object({ x: z.number(), y: z.number() }),
    to: z.object({ x: z.number(), y: z.number() }),
  }),
  /** Fill a field with a named secret the caller holds (a minted password, a code from the inbox); the value never crosses the socket. */
  targetSchema.extend({
    cmd: z.literal("place"),
    secret: z.string().min(1),
    goal: z.string().optional(),
  }),
  targetSchema.extend({ cmd: z.literal("select"), value: z.string(), goal: z.string().optional() }),
  targetSchema.extend({ cmd: z.literal("press"), key: z.string(), goal: z.string().optional() }),
  targetSchema.extend({
    cmd: z.literal("upload"),
    files: z.array(z.string().min(1)).min(1),
    goal: z.string().optional(),
  }),
  /** The files this session has (`--files <set>`), or with `all` every stored one: name, kind, type, size, note. */
  z.object({ cmd: z.literal("files"), all: z.boolean().optional() }),
  /** A doc's text (a resume, a transcript), to fill form fields by hand; a paper has none. Audited. */
  z.object({
    cmd: z.literal("read_file"),
    name: z.string().min(1),
    limit: z.number().int().positive().optional(),
  }),
  /** Keyboard into whatever is focused; not journaled as a locator act. */
  z.object({ cmd: z.literal("type"), text: z.string() }),
  z.object({ cmd: z.literal("key"), key: z.string() }),
  /** Play/pause for an agent driving this session: a person takes over, then hands back. */
  z.object({ cmd: z.literal("pause") }),
  z.object({ cmd: z.literal("resume") }),
  /** Accessibility tree of the page (or of one locator), capped. */
  z.object({
    cmd: z.literal("aria"),
    hints: hintsSchema.optional(),
    limit: z.number().int().positive().optional(),
    /** Secret-shaped strings are masked unless asked for raw. */
    raw: z.boolean().optional(),
  }),
  /** Interactive elements as one line each, what the repairer sees. */
  z.object({ cmd: z.literal("snapshot"), limit: z.number().int().positive().optional() }),
  /** The page's words as laid out (rows, tables, columns); `layout: false` = DOM order, `coords` = `@x,y` per line. */
  z.object({
    cmd: z.literal("text"),
    limit: z.number().int().positive().optional(),
    raw: z.boolean().optional(),
    layout: z.boolean().optional(),
    coords: z.boolean().optional(),
  }),
  z.object({ cmd: z.literal("url") }),
  /** Every open page (an OAuth popup beside the main one); `page` switches to one by index, "main" returns. */
  z.object({ cmd: z.literal("pages") }),
  z.object({
    cmd: z.literal("page"),
    index: z.union([z.number().int().min(0), z.literal("main")]),
  }),
  z.object({ cmd: z.literal("screenshot") }),
  /** A screenshot with a numbered box on each control in view, and the list; act with `hints:{mark:n}`. */
  z.object({ cmd: z.literal("marks") }),
  /**
   * The page calls (XHR, fetch, page loads), redacted: the newest `last` (40) as lines,
   * `filter` on the URL; `id` = one call with its body; `diff` = call shapes and response
   * keys against this site's last session. A personal profile's rows have no content.
   */
  z.object({
    cmd: z.literal("network"),
    id: z.number().int().positive().optional(),
    filter: z.string().optional(),
    last: z.number().int().positive().optional(),
    diff: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
  }),
  /** Save the page's HTML (scripts emptied, redacted); `diff` = lines added and removed since the last save of this URL shape. */
  z.object({ cmd: z.literal("html"), diff: z.boolean().optional() }),
  /** With `hints`, `js` is a function of that element, run in its frame (`el => el.className`). */
  z.object({
    cmd: z.literal("eval"),
    js: z.string(),
    raw: z.boolean().optional(),
    hints: hintsSchema.optional(),
  }),
  targetSchema.extend({ cmd: z.literal("count") }),
  /** Read an element's text and keep it under `as`; journaled, so the compiled flow reads it too. */
  targetSchema.extend({ cmd: z.literal("read"), as: z.string().regex(/^[a-z][a-zA-Z0-9]*$/) }),
  /**
   * The page as rows: `code` is a function body over `root` (the document) returning plain
   * objects, run in a sandbox and checked; without it the session's model writes one. Journaled
   * as a records op, so a walk built from this run replays it. `min` 0: the list may be empty.
   */
  z.object({
    cmd: z.literal("records"),
    as: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    goal: z.string().min(1),
    fields: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
          says: z.string(),
          optional: z.boolean().optional(),
        }),
      )
      .min(1),
    key: z.string().optional(),
    code: z.string().min(10).optional(),
    max: z.number().int().positive().optional(),
    min: z.number().int().nonnegative().optional(),
    raw: z.boolean().optional(),
  }),
  /** Read a secret the site just minted straight into the secret sink under `env`; nothing shows it. */
  targetSchema.extend({ cmd: z.literal("keep"), env: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
  z.object({ cmd: z.literal("note"), text: z.string() }),
  /** A part of the run starts here, named: `walks cut` builds each part as its own walk. */
  z.object({ cmd: z.literal("cut"), name: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
  /** Fetch a file with the page's sign-in: `url` (relative to the page) or the `href` at `hints`; kept beside the session as `as`. Journaled. */
  z.object({
    cmd: z.literal("download"),
    as: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    url: z.string().min(1).optional(),
    hints: hintsSchema.optional(),
  }),
  /** What this run is for, in words: the history groups runs by it and walks are built from it. */
  z.object({ cmd: z.literal("goal"), text: z.string().min(1).max(500) }),
  /** The goal is met, or cannot be: ends this run in the history. The session stays open; the next command starts a new run. */
  z.object({
    cmd: z.literal("done"),
    outcome: z.enum(["achieved", "failed"]),
    summary: z.string().max(500).optional(),
  }),
  /** Solve the captcha on the page: the checkbox by hand, a picture by the runner's eyes. Journaled, so the compiled flow solves it too. */
  z.object({ cmd: z.literal("captcha") }),
  /** Write the journal as a recording under `recordingsDir/<name>`. */
  z.object({ cmd: z.literal("save"), name: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
  /** What is recorded so far; `last` = only the newest n. */
  z.object({ cmd: z.literal("journal"), last: z.number().int().positive().optional() }),
  /** An act on the desktop, outside the browser: apps, menus, keys, a root command. */
  z.object({ cmd: z.literal("os"), act: desktopOpSchema }),
  /** End the session; `keep`: the journal stays, the next session on this port resumes it (`browsers stop`). */
  z.object({
    cmd: z.literal("close"),
    keep: z.boolean().optional(),
    /** Who closed it and why, for the run's history (a write took the idle session's profile). */
    why: z.string().max(300).optional(),
  }),
  /**
   * Several commands in one call, in order, stopping at the first that fails.
   * All are validated before any runs. One page diff for the lot.
   */
  z.object({
    cmd: z.literal("batch"),
    cmds: z.array(z.record(z.string(), z.unknown())).min(1).max(30),
  }),
]);
export type Command = z.infer<typeof commandSchema>;

/** Acts whose answer says what changed on the page, so the caller need not look again. */
export const LOOKS = new Set<Command["cmd"]>([
  "open",
  "captcha",
  "click",
  "drag",
  "fill",
  "place",
  "select",
  "upload",
  "press",
  "type",
  "key",
]);
/** Session controls and nesting stay out of a batch. */
export const UNBATCHABLE = new Set<Command["cmd"]>([
  "batch",
  "close",
  "pause",
  "resume",
  "save",
  "goal",
  "done",
]);
/** Acts a walk replays: the run keeps the page each was done on (`lookAt`, before the act). */
export const LOOKED_AT = new Set<Command["cmd"]>([
  "click",
  "drag",
  "fill",
  "place",
  "select",
  "upload",
  "press",
  "read",
  "keep",
  "captcha",
]);
/** Acts that type into a control that may sit in a frame still loading (a bank's challenge opens a moment after the pay click). */
export const WAITS_FOR_CONTROL = new Set<Command["cmd"]>(["fill", "place"]);
/** Answers a caller that reads the whole page each time would get instead: measured for the token report. */
export const WHOLE_PAGE = new Set<Command["cmd"]>([...LOOKS, "aria", "snapshot", "text", "batch"]);
/** Which explore flag gives a `place` secret, for the error when it is missing. */
export function placeHint(secret: string): string {
  const dot = secret.lastIndexOf(".");
  if (dot > 0)
    return `${secret} needs the session opened with --login ${secret.slice(0, dot)} (a stored login for that site)`;
  switch (secret) {
    case "phone":
    case "phoneLocal":
    case "email":
      return `${secret} needs the session opened with --signup <address>`;
    case "publicPhone":
    case "publicPhoneLocal":
      return `${secret} needs --signup <address> and PUBLIC_PHONE (Wren's business number) set`;
    case "password":
      return "password needs --signup <address> or --new-password <address>";
    case "code":
      return "code needs --codes <inbox> or --signup <address>";
    default:
      return `no flag gives "${secret}": names are phone, phoneLocal, publicPhone, publicPhoneLocal, email, password, code, <site>.username|password|code|phone|phoneLocal, card.*, card.code (the bank's text)`;
  }
}

export const toLocatorHints = (h: z.infer<typeof hintsSchema>): LocatorHints => ({
  tag: h.tag ?? "",
  role: h.role ?? null,
  name: h.name ?? null,
  text: h.text ?? null,
  placeholder: h.placeholder ?? null,
  id: h.id ?? null,
  testId: h.testId ?? null,
  href: h.href ?? null,
  inputType: h.inputType ?? null,
  ...(h.css ? { css: h.css } : {}),
  ...(h.nth ? { nth: h.nth } : {}),
  ...(h.frame ? { frame: h.frame } : {}),
});
