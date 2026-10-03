/**
 * Which stored account a name means. An account is a credential: its site,
 * its username (who it is) and its roles (what it is for: `main`, `alt`,
 * `wren`). A caller names one as `site` (the main one, or the only one),
 * `site@role` or `site@username`; all three reach the same entry. The store
 * key is plumbing: env and SSM names carry no `_` and no case, so a key
 * cannot be the username, and keys made before roles stay as they were.
 */

import { type CredentialInput, type CredentialStore, ROLE_NAME } from "credvault";

/** The role a bare site name means. */
export const MAIN = "main";

/** One stored account, as resolution sees it: no secret. */
export interface Held {
  key: string;
  username: string;
  roles: readonly string[];
}

/** `x@wren` → `x`; `google@will@a.com` → `google`. */
export const siteOf = (name: string): string => {
  const at = name.indexOf("@");
  return at < 0 ? name : name.slice(0, at);
};

/** `x@wren` → `wren`; `x` → null. */
export const labelOf = (name: string): string | null => {
  const at = name.indexOf("@");
  return at < 0 ? null : name.slice(at + 1);
};

/** A new account's key: lowercase, `_` → `-`, the form SSM reads back. */
export const keyFor = (name: string): string => name.toLowerCase().replace(/_/g, "-");

/**
 * The roles an account answers to: its own, plus its key's label (`x@wren`
 * answers to `wren`, a bare `x` to `main`). A key's label is claimed like a
 * role, so the key and a role can never name two different accounts.
 */
export const claims = (h: Held): string[] => [
  ...new Set([...h.roles, (labelOf(h.key) ?? MAIN).toLowerCase()]),
];

/**
 * The roles worth showing for an account: its claims, less a label that is
 * only its username (`google@will@a.com`) or no role word, and less an
 * implied `main` when it is the site's only account.
 */
export function shownRoles(h: Held, accountsOnSite: number): string[] {
  const label = labelOf(h.key)?.toLowerCase() ?? null;
  return claims(h).filter(
    (r) =>
      ROLE_NAME.test(r) &&
      r !== h.username.toLowerCase() &&
      !(r === MAIN && label === null && accountsOnSite === 1 && !h.roles.includes(MAIN)),
  );
}

/**
 * The key `asked` means among `held`, or null: the key itself, then the
 * account holding the role (a bare site: `main`), then the username, then a
 * bare site's only account.
 */
export function resolveAccount(held: readonly Held[], asked: string): string | null {
  const site = siteOf(asked);
  const label = labelOf(asked)?.toLowerCase() ?? null;
  const on = held.filter((h) => siteOf(h.key) === site);
  const one = (hits: readonly Held[]) => (hits.length === 1 ? (hits[0]?.key ?? null) : null);
  if (on.some((h) => h.key === asked)) return asked;
  return (
    one(on.filter((h) => h.roles.includes(label ?? MAIN))) ??
    (label === null ? one(on) : one(on.filter((h) => h.username.toLowerCase() === label)))
  );
}

/** Every account stored on `site`, read through `store` (an unarmed one: a lookup is not a use). */
export async function heldOn(store: CredentialStore, site: string): Promise<Held[]> {
  const out: Held[] = [];
  for (const key of await store.list()) {
    if (siteOf(key) !== site) continue;
    const c = await store.get(key);
    if (c && !c.canary) out.push({ key, username: c.username, roles: c.roles ?? [] });
  }
  return out;
}

/** The roles in `roles` another account on the site already answers to, with whose they are. */
export function rolesTaken(
  held: readonly Held[],
  key: string,
  roles: readonly string[],
): { role: string; username: string }[] {
  return held
    .filter((h) => h.key !== key && siteOf(h.key) === siteOf(key))
    .flatMap((h) =>
      claims(h)
        .filter((r) => roles.includes(r))
        .map((role) => ({ role, username: h.username })),
    );
}

export interface NamedStore extends CredentialStore {
  /** The stored key a name means, or null when nothing is stored under it. */
  keyOf(name: string): Promise<string | null>;
  /** The store under the names, by key: what `giveRole` moves entries in. */
  stored: CredentialStore;
}

/**
 * `store`, addressed by account names: `get`, `put` and `remove` take
 * `site`, `site@role` or `site@username`. A put of a name that means no
 * account stores a new one under `keyFor(name)`; a put that names no roles
 * keeps the account's. A put that gives the
 * account a role another account on the site holds is refused: one account
 * per role per site (`creds role` moves one). `raw` reads usernames and
 * roles; pass the store below any canary layer.
 */
export function namedStore(store: CredentialStore, raw: CredentialStore = store): NamedStore {
  const remove = store.remove?.bind(store);
  const keyOf = async (name: string) => resolveAccount(await heldOn(raw, siteOf(name)), name);
  return {
    keyOf,
    stored: store,
    async get(name) {
      return store.get((await keyOf(name)) ?? name);
    },
    async put(name, cred: CredentialInput) {
      const held = await heldOn(raw, siteOf(name));
      const key = resolveAccount(held, name) ?? keyFor(name);
      // Roles stay unless the write names them: a new password is not a new purpose.
      const roles = cred.roles ?? held.find((h) => h.key === key)?.roles ?? [];
      const taken = rolesTaken(held, key, roles);
      if (taken[0])
        throw new Error(
          `${siteOf(key)}@${taken[0].role} is ${taken[0].username}: \`autobrowse creds role ${siteOf(key)} ${taken[0].role} <account>\` moves it`,
        );
      await store.put(key, roles.length ? { ...cred, roles: [...roles] } : cred);
    },
    list: () => store.list(),
    ...(remove ? { remove: async (name: string) => remove((await keyOf(name)) ?? name) } : {}),
  };
}

/** What `giveRole` changed: roles taken off other accounts, keys moved off the role's name. */
export interface RoleMove {
  key: string;
  took: string[];
  /** An account whose key was the role's name (`reddit@alt`), now under its username. */
  renamed: { from: string; to: string }[];
}

/**
 * Give `role` to the account stored under `key`, taking it off any other
 * account on the site. An account that answers to the role through its key
 * (`reddit@alt`, a bare `x` for main) moves to `site@<username>`: copied,
 * read back, then removed (history keeps the old entry).
 */
export async function giveRole(
  store: CredentialStore,
  key: string,
  role: string,
): Promise<RoleMove> {
  if (!ROLE_NAME.test(role))
    throw new Error(`not a role: ${role} (a lowercase word: a-z, 0-9, . and -)`);
  const site = siteOf(key);
  const held = await heldOn(store, site);
  const target = held.find((h) => h.key === key);
  if (!target) throw new Error(`no account stored as ${key}`);
  const move: RoleMove = { key, took: [], renamed: [] };
  for (const h of held) {
    if (h.key === key || !claims(h).includes(role)) continue;
    const cred = await store.get(h.key);
    if (!cred) continue;
    const roles = h.roles.filter((r) => r !== role);
    if ((labelOf(h.key) ?? MAIN).toLowerCase() !== role) {
      await store.put(h.key, { ...cred, roles });
      move.took.push(h.username);
      continue;
    }
    const to = keyFor(`${site}@${h.username}`);
    if (!store.remove) throw new Error(`this store cannot remove; ${h.key} keeps ${role}`);
    if (held.some((o) => o.key === to) || (await store.get(to)))
      throw new Error(`${h.key} answers to ${role} by its name, and ${to} is taken: nothing moved`);
    await store.put(to, { ...cred, roles });
    const back = await store.get(to);
    if (back?.username !== cred.username || back.password !== cred.password)
      throw new Error(`${to} did not read back as ${h.key}; ${h.key} left as is`);
    await store.remove(h.key);
    move.renamed.push({ from: h.key, to });
  }
  const cred = await store.get(key);
  if (!cred) throw new Error(`no account stored as ${key}`);
  if (!target.roles.includes(role))
    await store.put(key, { ...cred, roles: [...target.roles, role] });
  return move;
}

/** Take `role` off the account that holds it in its roles; a key's own name stays (rename the key instead). */
export async function dropRole(
  store: CredentialStore,
  site: string,
  role: string,
): Promise<string | null> {
  const held = await heldOn(store, site);
  const h = held.find((x) => x.roles.includes(role));
  if (!h) {
    const named = held.find((x) => claims(x).includes(role));
    if (named)
      throw new Error(
        `${named.key} answers to ${role} by its key; give ${role} to another account instead`,
      );
    return null;
  }
  const cred = await store.get(h.key);
  if (cred) await store.put(h.key, { ...cred, roles: h.roles.filter((r) => r !== role) });
  return h.username;
}
