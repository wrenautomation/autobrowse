/**
 * The desktop leg of a chore: what a person does outside the browser. Apps,
 * menus, dialogs and settings panes are reached through the OS accessibility
 * tree (role + name, like the browser's aria), never by pixel. A shell
 * command that needs root goes through `sudo -n` with a rule set up once.
 * macOS in `mac.ts`; a host without a desktop (the prod box) says so.
 */
import { z } from "zod";

export const desktopTargetSchema = z.object({
  /** Which app owns the control; the frontmost one when absent. */
  app: z.string().optional(),
  role: z.string().optional(),
  name: z.string(),
});
export type DesktopTarget = z.infer<typeof desktopTargetSchema>;

/** One desktop act, as the explore server takes it and the journal keeps it. */
export const desktopOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("apps") }),
  z.object({ op: z.literal("open"), app: z.string() }),
  z.object({
    op: z.literal("tree"),
    app: z.string().optional(),
    depth: z.number().int().optional(),
  }),
  desktopTargetSchema.extend({ op: z.literal("click") }),
  /** `secret` marks a password typed into a dialog: the journal keeps only that something was typed. */
  z.object({ op: z.literal("type"), text: z.string(), secret: z.boolean().optional() }),
  /** "cmd+shift+4", "return", "escape", "tab", "down"… */
  z.object({ op: z.literal("key"), combo: z.string() }),
  z.object({ op: z.literal("shot") }),
  z.object({ op: z.literal("shell"), command: z.string(), root: z.boolean().optional() }),
  z.object({ op: z.literal("wait"), ms: z.number().int().positive() }),
]);
export type DesktopOp = z.infer<typeof desktopOpSchema>;

export interface DesktopNode {
  role: string;
  name: string;
  value: string | null;
  enabled: boolean;
  depth: number;
}

export interface Permissions {
  /** System Settings → Privacy & Security → Accessibility, for the process running node. */
  accessibility: boolean;
  /** `sudo -n` works: a sudoers rule for this user, or root already. */
  root: boolean;
}

export interface Desktop {
  readonly id: string;
  apps(): Promise<string[]>;
  /** Activate the app, launching it when needed. */
  open(app: string): Promise<void>;
  tree(app?: string, depth?: number): Promise<DesktopNode[]>;
  click(target: DesktopTarget): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;
  screenshot(file: string): Promise<void>;
  shell(command: string, root?: boolean): Promise<{ code: number; stdout: string; stderr: string }>;
  permissions(): Promise<Permissions>;
}

/** The tree as text, the way `aria` prints a page: one control per line, indented by depth. */
export function treeText(nodes: DesktopNode[]): string {
  return nodes
    .map(
      (n) =>
        `${"  ".repeat(n.depth)}- ${n.role} "${n.name}"${n.value !== null ? `: ${n.value}` : ""}${n.enabled ? "" : " [disabled]"}`,
    )
    .join("\n");
}

/** A host with no desktop (a Linux box, CI): every act says so instead of failing oddly. */
export function noDesktop(reason = "this host has no desktop"): Desktop {
  const refuse = async (): Promise<never> => {
    throw new Error(reason);
  };
  return {
    id: "none",
    apps: async () => [],
    open: refuse,
    tree: refuse,
    click: refuse,
    type: refuse,
    key: refuse,
    screenshot: refuse,
    shell: refuse,
    permissions: async () => ({ accessibility: false, root: false }),
  };
}

/** Scripted desktop for tests: a fixed tree, a log of every act. */
export function fakeDesktop(tree: DesktopNode[] = [], apps: string[] = ["Finder"]) {
  const acts: DesktopOp[] = [];
  const d: Desktop & { acts: DesktopOp[] } = {
    id: "fake",
    acts,
    apps: async () => apps,
    async open(app) {
      acts.push({ op: "open", app });
    },
    async tree() {
      return tree;
    },
    async click(t) {
      if (!tree.some((n) => n.name === t.name && (!t.role || n.role === t.role)))
        throw new Error(`no ${t.role ?? "control"} named "${t.name}"`);
      acts.push({ op: "click", ...t });
    },
    async type(text) {
      acts.push({ op: "type", text });
    },
    async key(combo) {
      acts.push({ op: "key", combo });
    },
    async screenshot() {
      acts.push({ op: "shot" });
    },
    async shell(command, root) {
      acts.push({ op: "shell", command, ...(root ? { root } : {}) });
      return { code: 0, stdout: "", stderr: "" };
    },
    permissions: async () => ({ accessibility: true, root: true }),
  };
  return d;
}
