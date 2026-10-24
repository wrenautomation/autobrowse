/**
 * `autobrowse setup`: the one conversation a person has with the tool.
 * It asks only for what the picked tier needs and what is missing:
 * tier 0 nothing, tier 1 a model and the sites that sign in as you (plus
 * where codes arrive), tier 2 a local Restate. Secrets are typed hidden and
 * stored sealed; settings go to the .env. It ends on what to run next.
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

/** 0: public pages, no keys. 1: + a model and your own accounts. 2: + durable runs (local Restate). */
export type Tier = 0 | 1 | 2;

export interface SetupOptions {
  /** Unset: setup asks. */
  tier?: Tier;
  devices?: readonly DeviceLink[];
  /** Where picked settings go (the .env). */
  env?: { put(name: string, value: string): Promise<void> };
  /** Settings already present; a set one is not asked again. */
  set?: { llm?: boolean; codesInbox?: boolean; phone?: boolean; restate?: boolean };
  /** Is this program on the PATH (`claude`, `restate-server`)? */
  has?: (bin: string) => boolean;
  /** Ask for SMS codes through this Mac's Messages. */
  mac?: boolean;
  /** Ask for every known site in turn (the operator's roster), not a picked few. */
  all?: boolean;
}

const LOCAL_RESTATE = {
  RESTATE_INGRESS_URL: "http://localhost:8080",
  RESTATE_ADMIN_URL: "http://localhost:9070",
  RESTATE_ENDPOINT_URL: "http://localhost:9081",
};

const NEXT: Record<Tier, string[]> = {
  0: [
    "next: `autobrowse explore example --url https://example.com`, then `compile <name> --no-llm` and `try <name>`",
  ],
  1: [
    "next: `autobrowse login <site> --headed` once per site, then `autobrowse enroll-totp <site>` where 2FA is off",
    '      `autobrowse do "<a task in words>"` runs the agent',
  ],
  2: [
    "next: `restate-server` in one terminal, `autobrowse worker` in another; runs now survive restarts",
  ],
};

async function pickTier(io: Prompter): Promise<Tier> {
  io.say(
    "Tiers: 0 = public pages, no keys. 1 = + a model and your own accounts. 2 = + durable runs.",
  );
  const a = (await io.ask("Which tier? [0/1/2] (default 0) ")).trim();
  return a === "1" || a === "2" ? (Number(a) as Tier) : 0;
}

/** The model: your Claude Code subscription when `claude` is here, else an Anthropic key. */
async function askModel(io: Prompter, opts: SetupOptions): Promise<void> {
  if (opts.set?.llm) return io.say("model: set");
  const env = opts.env;
  if (!env) return;
  if (opts.has?.("claude")) {
    const a = (await io.ask("\nmodel: use your Claude Code subscription (no key)? [Y/n] "))
      .trim()
      .toLowerCase();
    if (a !== "n" && a !== "no") {
      await env.put("LLM_PROVIDER", "claude-code");
      return io.say("  model: claude-code");
    }
  }
  const key = (
    await io.askHidden(
      "\nmodel: Anthropic API key (typed hidden; empty = skip; OpenAI: LLM_PROVIDER=openai + OPENAI_API_KEY in .env): ",
    )
  ).trim();
  if (!key) return io.say("  model: skipped (the agent and `do` wait for one)");
  await env.put("LLM_PROVIDER", "anthropic");
  await env.put("ANTHROPIC_API_KEY", key);
  io.say("  model: anthropic");
}

/** The sites that sign in as you: picked by name, unless `all`. */
async function pickSites(
  io: Prompter,
  sites: readonly SiteLogin[],
  all: boolean,
): Promise<readonly SiteLogin[]> {
  if (all) return sites;
  const known = [...new Set(sites.map((s) => s.site))];
  io.say(`\nsites with a sign-in walk: ${known.join(", ")}`);
  const names = (await io.ask("Which sign in as you? Names, comma separated (empty = none): "))
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter((n) => !known.includes(n));
  for (const n of unknown)
    io.say(`  ${n}: no sign-in walk yet; \`autobrowse creds set ${n}\` stores it anyway`);
  return sites.filter((s) => names.includes(s.site));
}

/** Where one-time codes arrive: an inbox, and on a Mac the paired phone. */
async function askCodes(io: Prompter, opts: SetupOptions): Promise<void> {
  const env = opts.env;
  if (!env) return;
  if (!opts.set?.codesInbox) {
    const inbox = (
      await io.ask("\ncodes: inbox that gets sign-in codes by email (empty = skip): ")
    ).trim();
    if (inbox) await env.put("CODES_INBOX", inbox);
  }
  if (opts.mac && !opts.set?.phone) {
    const phone = (
      await io.ask(
        "codes: phone paired with this Mac for SMS codes, like +15551234567 (empty = skip): ",
      )
    ).replace(/[\s()-]/g, "");
    if (/^\+\d{8,15}$/.test(phone)) {
      await env.put("PHONE_NUMBER", phone);
      io.say("  run setup again: it checks that Messages can be read");
    } else if (phone) io.say("  not a phone number in +<country><number> form; skipped");
  }
}

/** Tier 2: Restate on this machine, and the worker registers itself with it. */
async function askRestate(io: Prompter, opts: SetupOptions): Promise<void> {
  io.say(
    opts.has?.("restate-server")
      ? "\nrestate: installed"
      : "\nrestate: not installed. Once: `brew install restatedev/tap/restate` (or docs.restate.dev)",
  );
  if (opts.set?.restate || !opts.env) return;
  for (const [name, value] of Object.entries(LOCAL_RESTATE)) await opts.env.put(name, value);
  io.say("  .env: the worker registers itself with the local Restate");
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
  const tier = opts.tier ?? (await pickTier(io));
  if (tier === 0) {
    io.say("tier 0: nothing to store.");
    for (const line of NEXT[0]) io.say(line);
    return { stored, skipped, devices };
  }
  await askModel(io, opts);
  const picked = await pickSites(io, sites, opts.all ?? false);
  const have = new Set(await store.list());
  // The operator's roster asks for google up front; a picked few ask for a provider only when a site uses its button.
  const needs = needsFor(picked, opts.all ? {} : { providers: [] });
  for (const need of needs) {
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
        if (!have.has(provider) && !needs.some((n) => n.name === provider))
          needs.push({
            name: provider,
            sites: [],
            ask: `Your ${provider} account`,
            viaChoices: [],
          });
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
  await askCodes(io, opts);
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
  if (tier === 2) await askRestate(io, opts);
  io.say("");
  if (stored.length) io.say(`stored: ${stored.join(", ")}`);
  if (skipped.length) io.say(`skipped: ${skipped.join(", ")} (run setup again any time)`);
  for (const line of NEXT[1]) io.say(line);
  if (tier === 2) for (const line of NEXT[2]) io.say(line);
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
