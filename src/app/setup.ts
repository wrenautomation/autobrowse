/**
 * `autobrowse setup`: the one conversation a person has with the tool.
 * It asks only for what is missing (a root credential per identity
 * provider, the sites that use their own password), types hidden, stores
 * sealed, and says what runs next. Everything after this is the tool's.
 */

import type { Interface } from "node:readline/promises";
import type { CredentialStore } from "credvault";
import type { SiteLogin } from "../auth/login.js";
import type { Provider } from "../auth/providers.js";

export interface Prompter {
  ask(question: string): Promise<string>;
  /** Same, without echo. */
  askHidden(question: string): Promise<string>;
  say(line: string): void;
}

/** What `setup` wants for one credential name. */
export interface Need {
  name: string;
  /** Which sites this credential signs in. */
  sites: string[];
  /** What setup says, in the site's own words. */
  ask: string;
  /** Offered when a site behind this credential can also go through a provider's button. */
  viaChoices: Provider[];
}

/** Credential names the site list needs, grouped: `google` covers every site that names it. */
export function needsFor(
  sites: readonly SiteLogin[],
  opts: { providers?: readonly string[] } = {},
): Need[] {
  const providers = new Set(opts.providers ?? ["google"]);
  const byName = new Map<string, Need>();
  for (const s of sites) {
    const name = s.credential ?? s.site;
    const need = byName.get(name) ?? { name, sites: [], ask: s.ask ?? name, viaChoices: [] };
    need.sites.push(s.site);
    for (const v of s.via ?? []) if (!need.viaChoices.includes(v)) need.viaChoices.push(v);
    byName.set(name, need);
  }
  for (const p of providers)
    if (!byName.has(p))
      byName.set(p, { name: p, sites: [], ask: `Your ${p} account`, viaChoices: [] });
  // Providers first: a site behind a button needs its provider stored.
  return [...byName.values()].sort(
    (a, b) => Number(providers.has(b.name)) - Number(providers.has(a.name)),
  );
}

/** A device this system leans on; `check` says what works and what the person does once. */
export interface DeviceLink {
  name: string;
  check(): Promise<{ ok: boolean; fix: string[] }>;
  /** Put the person in front of the switch (open the settings pane). */
  guide?: () => Promise<void>;
}

export interface SetupOptions {
  devices?: readonly DeviceLink[];
}

export async function runSetup(
  io: Prompter,
  store: CredentialStore,
  sites: readonly SiteLogin[],
  opts: SetupOptions = {},
): Promise<{ stored: string[]; skipped: string[]; devices: Record<string, boolean> }> {
  const devices: Record<string, boolean> = {};
  const stored: string[] = [];
  const skipped: string[] = [];
  const have = new Set(await store.list());
  for (const need of needsFor(sites)) {
    if (have.has(need.name)) {
      io.say(`${need.name}: stored`);
      continue;
    }
    io.say(`\n${need.name}: ${need.ask}`);
    if (need.viaChoices.length) {
      const provider = need.viaChoices[0] as Provider;
      const via = (
        await io.ask(`  do you log in there with the "Sign in with ${provider}" button? [y/N] `)
      )
        .trim()
        .toLowerCase();
      if (via === "y" || via === "yes") {
        const username = (await io.ask(`  which ${provider} account (email): `)).trim();
        // A via credential carries no password of its own; the provider's does the work.
        await store.put(need.name, { username: username || "-", via: provider });
        stored.push(need.name);
        continue;
      }
    }
    const username = (await io.ask("  email (empty = skip for now): ")).trim();
    if (!username) {
      skipped.push(need.name);
      continue;
    }
    const password = await io.askHidden("  password (typed hidden): ");
    if (!password) {
      skipped.push(need.name);
      continue;
    }
    const totp = (
      await io.askHidden(
        "  already using an authenticator app there? paste its setup key, else empty (enroll-totp turns one on later): ",
      )
    ).trim();
    try {
      await store.put(need.name, {
        username,
        password,
        ...(totp ? { totpSecret: totp } : {}),
      });
      stored.push(need.name);
    } catch (err) {
      io.say(`  not stored: ${err instanceof Error ? err.message : String(err)}`);
      skipped.push(need.name);
    }
  }
  for (const d of opts.devices ?? []) {
    const r = await d.check();
    devices[d.name] = r.ok;
    io.say(`\n${d.name}: ${r.ok ? "linked" : "not yet"}`);
    for (const line of r.fix) io.say(`  once: ${line}`);
    if (!r.ok && d.guide) {
      await d.guide();
      io.say("  (the settings pane is open; run setup again after)");
    }
  }
  io.say("");
  if (stored.length) io.say(`stored: ${stored.join(", ")}`);
  if (skipped.length) io.say(`skipped: ${skipped.join(", ")} (run setup again any time)`);
  io.say(
    "next: `autobrowse login <site> --headed` once per site, then `autobrowse enroll-totp <site>` where 2FA is off",
  );
  return { stored, skipped, devices };
}

/** Terminal prompter: hidden input mutes echo through the readline output hook. */
export function terminalPrompter(rl: Interface, out: NodeJS.WriteStream): Prompter {
  let hidden = false;
  const write = out.write.bind(out);
  const muted = rl as Interface & { _writeToOutput?: (s: string) => void };
  const original = muted._writeToOutput;
  muted._writeToOutput = (s: string) => {
    if (hidden && !/[?:] $/.test(s)) return;
    if (original) original.call(rl, s);
    else write(s);
  };
  return {
    ask: (q) => rl.question(q),
    async askHidden(q) {
      hidden = true;
      try {
        const v = await rl.question(q);
        write("\n");
        return v;
      } finally {
        hidden = false;
      }
    },
    say: (line) => write(`${line}\n`),
  };
}
