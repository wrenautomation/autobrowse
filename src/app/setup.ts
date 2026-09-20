/**
 * `autobrowse setup`: the one conversation a person has with the tool.
 * It asks only for what is missing (a root credential per identity
 * provider, the sites that use their own password), types hidden, stores
 * sealed, and says what runs next. Everything after this is the tool's.
 */
import type { Interface } from "node:readline/promises";
import type { CredentialStore } from "../auth/credentials.js";
import type { SiteLogin } from "../auth/login.js";

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
  /** Offered when the site can also go through a provider's button. */
  viaChoices: Array<"google">;
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
    const need = byName.get(name) ?? { name, sites: [], viaChoices: [] };
    need.sites.push(s.site);
    byName.set(name, need);
  }
  for (const p of providers)
    if (!byName.has(p)) byName.set(p, { name: p, sites: [], viaChoices: [] });
  for (const need of byName.values())
    if (!providers.has(need.name))
      need.viaChoices = [...providers].filter((p): p is "google" => p === "google");
  // Providers first: a site behind a button needs its provider stored.
  return [...byName.values()].sort(
    (a, b) => Number(providers.has(b.name)) - Number(providers.has(a.name)),
  );
}

/** A device this system leans on; `check` says what works and what the person does once. */
export interface DeviceLink {
  name: string;
  check(): { ok: boolean; fix: string[] };
  /** Put the person in front of the switch (open the settings pane). */
  guide?: () => void;
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
    const who = need.sites.length ? ` (signs in ${need.sites.join(", ")})` : " (identity provider)";
    io.say(`\n${need.name}${who}`);
    if (need.viaChoices.length) {
      const via = (
        await io.ask(
          `  sign in with ${need.viaChoices.join("/")} button instead of a password? [y/N] `,
        )
      )
        .trim()
        .toLowerCase();
      if (via === "y" || via === "yes") {
        const provider = need.viaChoices[0] as "google";
        const username = (await io.ask(`  ${provider} account email (for the record): `)).trim();
        // A via credential carries no password of its own; the provider's does the work.
        await store.put(need.name, { username: username || "-", password: "-", via: provider });
        stored.push(need.name);
        continue;
      }
    }
    const username = (await io.ask("  username/email (empty = skip): ")).trim();
    if (!username) {
      skipped.push(need.name);
      continue;
    }
    const password = await io.askHidden("  password: ");
    if (!password) {
      skipped.push(need.name);
      continue;
    }
    const totp = (
      await io.askHidden("  authenticator seed if 2FA is already on (empty = none): ")
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
    const r = d.check();
    devices[d.name] = r.ok;
    io.say(`\n${d.name}: ${r.ok ? "linked" : "not yet"}`);
    for (const line of r.fix) io.say(`  once: ${line}`);
    if (!r.ok && d.guide) {
      d.guide();
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
