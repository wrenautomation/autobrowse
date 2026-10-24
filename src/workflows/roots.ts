/**
 * Where compiled workflows live. The shipped flows sit beside this file
 * (`src/workflows` in a clone, `dist/workflows` in the npm package). A clone
 * compiles into its own tree; an install compiles into the user's folder
 * (`AUTOBROWSE_WORKFLOWS`, default `~/.config/autobrowse/workflows`), where
 * links in `node_modules` let the flows import the library and zod by name.
 */
import { existsSync } from "node:fs";
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE = "@wrenautomation/autobrowse";

/** The shipped flows: this file's own folder. */
export const SHIPPED_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(dirname(SHIPPED_DIR));
const IN_CLONE = basename(dirname(SHIPPED_DIR)) === "src";

export const userWorkflowsDir = (env = process.env, home = homedir()): string =>
  env.AUTOBROWSE_WORKFLOWS || join(home, ".config/autobrowse/workflows");

/** Where the compiler writes, and the import the rendered files use for the library. */
export const COMPILED_DIR = IN_CLONE ? SHIPPED_DIR : userWorkflowsDir();
export const COMPILED_LIB = IN_CLONE ? "../../index.js" : PACKAGE;

/** Extra roots the catalog reads after COMPILED_DIR: the shipped flows, when they are elsewhere. */
export const shippedRoots = (): string[] => (COMPILED_DIR === SHIPPED_DIR ? [] : [SHIPPED_DIR]);

/** The folder of the package that `spec` resolves to from here. */
function packageDir(spec: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(spec)));
  while (!existsSync(join(dir, "package.json")) || basename(dirname(dir)) !== "node_modules") {
    const up = dirname(dir);
    if (up === dir) throw new Error(`no package folder for ${spec}`);
    dir = up;
  }
  return dir;
}

async function link(at: string, to: string): Promise<void> {
  const now = await lstat(at).then(
    (s) => (s.isSymbolicLink() ? readlink(at) : "not a link"),
    () => null,
  );
  if (now === to) return;
  if (now !== null) await rm(at, { recursive: true, force: true });
  await mkdir(dirname(at), { recursive: true });
  await symlink(to, at, "dir");
}

/**
 * Point `<root>/node_modules` at this install of the library and its zod.
 * An npx cache folder moves between versions, so each process links again.
 */
let linked: Promise<void> | undefined;
export const linkOnce = (): Promise<void> => {
  linked ??= linkLibraries();
  return linked;
};

export async function linkLibraries(
  root = COMPILED_DIR,
  pkg = { root: PKG_ROOT, zod: packageDir("zod") },
): Promise<void> {
  if (root === SHIPPED_DIR) return;
  await link(join(root, "node_modules", PACKAGE), pkg.root);
  await link(join(root, "node_modules", "zod"), pkg.zod);
}
