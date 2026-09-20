/**
 * macOS desktop through System Events (the accessibility tree) driven by
 * JavaScript for Automation, and `screencapture` for the picture. One
 * `osascript` call per act, a JSON argument in and JSON out, so every
 * script is a plain string that a test can read.
 *
 * What cannot be done from code: macOS grants Accessibility to the process
 * running node (Terminal, iTerm, the app) once, by hand, in System Settings.
 * `permissions()` says whether that happened.
 */
import { execFile } from "node:child_process";
import type { Desktop, DesktopNode, DesktopTarget, Permissions } from "./types.js";

export interface MacOptions {
  /** Run a program and give back its stdout; `osascript` and `screencapture` by default. */
  run?: (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Most nodes a tree walk returns; the walk is one Apple event per property. */
  maxNodes?: number;
  defaultDepth?: number;
}

/** Key names a person uses → System Events key codes. */
export const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  forwarddelete: 117,
};

const MODIFIERS: Record<string, string> = {
  cmd: "command down",
  command: "command down",
  shift: "shift down",
  alt: "option down",
  opt: "option down",
  option: "option down",
  ctrl: "control down",
  control: "control down",
};

/** "cmd+shift+4" → what `keystroke`/`key code` need. Throws on a key it does not know. */
export function parseCombo(combo: string): {
  key: string | null;
  code: number | null;
  using: string[];
} {
  const parts = combo
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const last = parts.pop();
  if (!last) throw new Error("empty key combo");
  const using = parts.map((p) => {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m) throw new Error(`unknown modifier "${p}" in "${combo}"`);
    return m;
  });
  const lower = last.toLowerCase();
  if (lower in KEY_CODES) return { key: null, code: KEY_CODES[lower] as number, using };
  if ([...last].length === 1) return { key: last, code: null, using };
  throw new Error(`unknown key "${last}" in "${combo}"`);
}

/** The tree walk, shared by `tree` and `click`: role/name/value/enabled per node, depth-first. */
const WALK = `
function nodes(a) {
  const se = Application("System Events");
  const proc = a.app ? se.applicationProcesses.byName(a.app) : se.applicationProcesses.whose({ frontmost: true })[0];
  if (!proc) throw new Error("no frontmost app");
  const out = [];
  const roots = [];
  // No Accessibility grant surfaces here, as an error naming assistive access; it must not read as an empty app.
  try { for (const w of proc.windows()) roots.push(w); } catch (e) { if (/assistive|not allowed/i.test(String(e))) throw e; }
  try { for (const m of proc.menuBars()) roots.push(m); } catch (e) {}
  function walk(el, depth) {
    if (out.length >= a.max || depth > a.depth) return;
    let role, title, desc, value, enabled;
    try { role = String(el.role()).replace(/^AX/, "").toLowerCase(); } catch (e) { return; }
    try { title = el.title(); } catch (e) { title = null; }
    try { desc = el.description(); } catch (e) { desc = null; }
    try { value = el.value(); } catch (e) { value = null; }
    try { enabled = el.enabled(); } catch (e) { enabled = true; }
    const name = String(title || desc || (role === "statictext" ? value : "") || "");
    const v = value === null || value === undefined || role === "statictext" ? null : String(value);
    if (role !== "group" || name) out.push({ role, name, value: v, enabled: enabled !== false, depth, el });
    let kids = [];
    try { kids = el.uiElements(); } catch (e) {}
    for (const k of kids) walk(k, depth + 1);
  }
  for (const r of roots) walk(r, 0);
  return out;
}
`;

const SCRIPTS = {
  apps: `function run(argv) {
  const se = Application("System Events");
  return JSON.stringify(se.applicationProcesses.whose({ backgroundOnly: false }).name());
}`,
  open: `function run(argv) {
  const a = JSON.parse(argv[0]);
  Application(a.app).activate();
  return "ok";
}`,
  tree: `${WALK}
function run(argv) {
  const a = JSON.parse(argv[0]);
  return JSON.stringify(nodes(a).map(({ el, ...n }) => n));
}`,
  click: `${WALK}
function run(argv) {
  const a = JSON.parse(argv[0]);
  const hit = nodes(a).find((n) => n.name === a.name && (!a.role || n.role === a.role));
  if (!hit) throw new Error("no " + (a.role || "control") + " named \\"" + a.name + "\\"");
  try { hit.el.click(); } catch (e) { hit.el.actions.byName("AXPress").perform(); }
  return "ok";
}`,
  type: `function run(argv) {
  const a = JSON.parse(argv[0]);
  Application("System Events").keystroke(a.text);
  return "ok";
}`,
  key: `function run(argv) {
  const a = JSON.parse(argv[0]);
  const se = Application("System Events");
  const using = a.using.length ? { using: a.using } : {};
  if (a.code !== null) se.keyCode(a.code, using); else se.keystroke(a.key, using);
  return "ok";
}`,
  probe: `function run() {
  const se = Application("System Events");
  return String(se.applicationProcesses.whose({ frontmost: true })[0].windows.length);
}`,
} as const;

function defaultRun(
  file: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 4 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function macDesktop(opts: MacOptions = {}): Desktop {
  const run = opts.run ?? defaultRun;
  const maxNodes = opts.maxNodes ?? 400;
  const defaultDepth = opts.defaultDepth ?? 8;
  const jxa = async (script: keyof typeof SCRIPTS, arg?: unknown): Promise<string> => {
    const r = await run("osascript", [
      "-l",
      "JavaScript",
      "-e",
      SCRIPTS[script],
      ...(arg === undefined ? [] : ["--", JSON.stringify(arg)]),
    ]);
    if (r.code !== 0) {
      const msg = r.stderr.trim().replace(/^.*?Error: /, "") || `osascript exited ${r.code}`;
      throw new Error(
        /assistive access|not allowed/i.test(msg) ? `${msg} (grant Accessibility)` : msg,
      );
    }
    return r.stdout.trim();
  };
  return {
    id: "mac",
    async apps() {
      return JSON.parse(await jxa("apps")) as string[];
    },
    async open(app) {
      try {
        await jxa("open", { app });
      } catch (err) {
        // Not a scriptable app by that name: let LaunchServices find it.
        const r = await run("open", ["-a", app]);
        if (r.code !== 0) throw err;
      }
    },
    async tree(app, depth) {
      const raw = JSON.parse(
        await jxa("tree", { app: app ?? null, depth: depth ?? defaultDepth, max: maxNodes }),
      ) as DesktopNode[];
      return raw;
    },
    async click(t: DesktopTarget) {
      await jxa("click", {
        app: t.app ?? null,
        role: t.role ?? null,
        name: t.name,
        depth: defaultDepth,
        max: maxNodes,
      });
    },
    async type(text) {
      await jxa("type", { text });
    },
    async key(combo) {
      await jxa("key", parseCombo(combo));
    },
    async screenshot(file) {
      const r = await run("screencapture", ["-x", file]);
      if (r.code !== 0) throw new Error(`screencapture: ${r.stderr.trim() || r.code}`);
    },
    async shell(command, root = false) {
      // Root goes through one audited helper, never a bare `sudo sh`: see `rootHelper()`.
      return root ? run("sudo", ["-n", ROOT_HELPER, command]) : run("/bin/sh", ["-c", command]);
    },
    async permissions(): Promise<Permissions> {
      const accessibility = await jxa("probe").then(
        () => true,
        () => false,
      );
      const root = (await run("sudo", ["-n", "true"])).code === 0;
      return { accessibility, root };
    },
  };
}

/**
 * Root, the careful way: sudoers lets this user run one root-owned helper
 * without a password, and the helper appends the command to a root-owned
 * log before running it. Revoking root is deleting one file; every root
 * command it ever ran is in the log.
 */
export const ROOT_HELPER = "/usr/local/libexec/autobrowse-root";
export const ROOT_LOG = "/var/log/autobrowse-root.log";

export function rootHelper(): string {
  return `#!/bin/sh
# autobrowse: run one command as root and log it. Installed by \`autobrowse desktop setup\`.
[ "$#" -eq 1 ] || { echo "usage: autobrowse-root <command>" >&2; exit 64; }
printf '%s %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SUDO_USER" "$1" >> ${ROOT_LOG}
exec /bin/sh -c "$1"
`;
}

export function sudoersLine(user: string): string {
  return `${user} ALL=(root) NOPASSWD: ${ROOT_HELPER}`;
}

/** What a person runs once (it asks for their password) to install the helper and the rule. */
export function rootSetupCommands(user: string, helperFile: string): string[] {
  return [
    `sudo install -o root -g wheel -m 755 ${helperFile} ${ROOT_HELPER}`,
    `sudo touch ${ROOT_LOG} && sudo chmod 600 ${ROOT_LOG}`,
    `echo '${sudoersLine(user)}' | sudo tee /etc/sudoers.d/autobrowse >/dev/null && sudo chmod 440 /etc/sudoers.d/autobrowse`,
  ];
}
