/**
 * Agent keys: what each agent may touch. autobrowse holds the passwords,
 * cards and signed-in browsers, so it is the one that refuses; the client
 * (wren, a person, an agent runner) only chooses which key each agent gets.
 * A key names the sites, workflows and tools it may use and the verbs it
 * may call; anything not named is refused, and every list an agent reads
 * shows only what it may use. The operator (UI_TOKEN, or local use with no
 * token) sees everything.
 *
 * The fence holds for agents that reach autobrowse over its API with a
 * key. An agent with a shell on the worker's machine is the operator.
 *
 * Stored as a sha256 of each key, never the key: it is shown once, at
 * `access grant`. A key is 32 random bytes, so a plain hash is enough.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/** What an agent key may call, beyond reading its own lists. */
export const VERBS = ["do", "run", "sites", "agent"] as const;
export type Verb = (typeof VERBS)[number];

export const scopeSchema = z.object({
  /** Sites, and which accounts: `github` = the default account, `github@wren` = that one, `github@*` = all. */
  sites: z.array(z.string().regex(/^[a-z][a-z0-9-]*(@(\*|[a-z0-9][a-z0-9.@_-]*))?$/i)).default([]),
  /** Compiled workflows by name; `*` ends a prefix (`higgsfield-*`). */
  workflows: z.array(z.string().min(1)).default([]),
  /** Command-line tool abilities by name. */
  tools: z.array(z.string().min(1)).default([]),
  /** `do` (the one verb), `run` (start and steer runs), `sites` (site APIs), `agent` (explore sessions). */
  can: z.array(z.enum(VERBS)).default([]),
});
export type ScopeRules = z.infer<typeof scopeSchema>;

export type Scope =
  | { operator: true; name: "operator" }
  | ({ operator: false; name: string } & ScopeRules);

export const OPERATOR: Scope = { operator: true, name: "operator" };

/** `github@wren` → [github, wren]; `github` → [github, ""] (the default account). */
const split = (site: string): [string, string] => {
  const at = site.indexOf("@");
  return at < 0 ? [site, ""] : [site.slice(0, at), site.slice(at + 1)];
};
const base = (site: string) => split(site)[0];
const glob = (pattern: string, name: string) =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;

/** Whether the scope may act as this site's account (`github`, `github@wren`). */
export function allowsSite(scope: Scope, site: string): boolean {
  if (scope.operator) return true;
  const [name, account] = split(site);
  return scope.sites.some((p) => {
    const [pName, pAccount] = split(p);
    return pName === name && (pAccount === "*" || pAccount === account);
  });
}

/** Whether any account of this site is in scope: the site shows up in lists. */
export const seesSite = (scope: Scope, site: string): boolean =>
  scope.operator || scope.sites.some((p) => base(p) === base(site));

export const allowsWorkflow = (scope: Scope, name: string): boolean =>
  scope.operator || scope.workflows.some((p) => glob(p, name));

export const allowsTool = (scope: Scope, name: string): boolean =>
  scope.operator || scope.tools.includes(name);

export const can = (scope: Scope, verb: Verb): boolean =>
  scope.operator || scope.can.includes(verb);

/** One stored key: its name, rules and the hash it is known by. */
export interface StoredKey extends ScopeRules {
  name: string;
  hash: string;
  createdAt: string;
}

export interface KeyStore {
  list(): StoredKey[];
  /** A new key under `name`: the value, shown once. A second key of the same name replaces the first. */
  add(name: string, rules: ScopeRules): { key: string; stored: StoredKey };
  revoke(name: string): boolean;
  /** The scope a presented key carries, or null when it is no key of ours. */
  resolve(key: string): Scope | null;
}

const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");
export const KEY_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** Keys in one JSON file (0600), read again only when it changes. */
export function fileKeys(file: string, now: () => Date = () => new Date()): KeyStore {
  let cache: { mtimeMs: number; keys: StoredKey[] } | null = null;
  const read = (): StoredKey[] => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      return [];
    }
    if (cache?.mtimeMs === mtimeMs) return cache.keys;
    const keys = JSON.parse(readFileSync(file, "utf8")) as StoredKey[];
    cache = { mtimeMs, keys };
    return keys;
  };
  const write = (keys: StoredKey[]) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    cache = null;
  };
  return {
    list: () => read(),
    add(name, rules) {
      if (!KEY_NAME.test(name))
        throw new Error("a key name is lowercase letters, digits and dashes");
      if (name === "operator") throw new Error("operator is the UI token, not an agent key");
      const parsed = scopeSchema.parse(rules);
      const key = `abk_${name}_${randomBytes(32).toString("base64url")}`;
      const stored: StoredKey = {
        name,
        ...parsed,
        hash: hashOf(key),
        createdAt: now().toISOString(),
      };
      write([...read().filter((k) => k.name !== name), stored]);
      return { key, stored };
    },
    revoke(name) {
      const keys = read();
      if (!keys.some((k) => k.name === name)) return false;
      write(keys.filter((k) => k.name !== name));
      return true;
    },
    resolve(key) {
      const hash = hashOf(key);
      const hit = read().find((k) => k.hash === hash);
      if (!hit) return null;
      const { hash: _h, createdAt: _c, ...rest } = hit;
      return { operator: false, ...rest };
    },
  };
}
