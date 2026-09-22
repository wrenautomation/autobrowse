/**
 * What only the person can give, as data with a check each: a credential
 * for a site's login, a developer app's keys, a consent, the phone link, a
 * card, a decision. Most rows are derived from the site catalog (every
 * site API says which login its consent uses and which env names it needs),
 * so the list stays current as sites are added; the rest is a short
 * hand-kept table. A row clears itself when its check passes; a decision
 * clears when the person says `needs done <id>`. `autobrowse needs` is the
 * one place to look; NEEDS-WILLIAM.md only carries the words around it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type CredentialStore, type EnvListing, expiring } from "credvault";
import { type Identity, identityFor } from "../auth/identities.js";
import type { SiteLogin } from "../auth/login.js";
import { signupInbox } from "../auth/signup.js";
import { expandHome } from "../google-auth.js";
import { gmailOAuth } from "../sites/gmail.js";
import { accountEnv } from "../sites/oauth.js";
import type { OAuthSpec, SetupStep, SiteApi } from "../sites/types.js";
import { profileOf } from "../sites/wire.js";
import { youtubeOAuth } from "../sites/youtube.js";

export type NeedKind = "credential" | "keys" | "consent" | "phone" | "mac" | "money" | "decision";

export interface Need {
  id: string;
  kind: NeedKind;
  /** What is missing, in the site's own terms. */
  what: string;
  /** What having it makes possible. */
  unlocks: string;
  /** The exact command(s) or steps; the first one is what `needs <id>` runs when it can. */
  how: string[];
  /** Another need that must clear first. */
  after?: string;
  /** A pass means it is in hand; absent for a decision (cleared by hand). */
  check?: () => Promise<boolean>;
}

export interface NeedsContext {
  sites: readonly SiteApi[];
  logins: readonly SiteLogin[];
  identities: readonly Identity[];
  /** Unarmed: the checks read every credential's presence, never a canary trip. */
  credentials: CredentialStore;
  env: (name: string) => string | undefined;
  /** What the sink holds, with each value's expiry; absent = expiry unknown. */
  kept?: () => Promise<EnvListing[]>;
  workspaceDomain: string | null;
  /** The paired phone's legs, when a number is configured. */
  phone?: (() => Promise<{ read: boolean; send: boolean }>) | null;
  /** The desktop leg's permissions on this Mac. */
  desktop?: (() => Promise<{ accessibility: boolean; root: boolean }>) | null;
}

/** The login a site's consent signs in with (`facebook/oauth-consent` → `facebook`), or null for a token site. */
export function consentLoginOf(s: SiteApi): string | null {
  const step = s.setup.find((st) => "oauth" in st.how);
  const spec = step && "oauth" in step.how ? step.how.oauth : null;
  return spec && "flow" in spec.consent ? (spec.consent.flow.split("/")[0] ?? null) : null;
}

/** In hand: in this process's env, or in the store the sink writes (SSM holds what the laptop's .env may not). */
async function holds(ctx: NeedsContext, name: string): Promise<boolean> {
  return Boolean(ctx.env(name)) || Boolean((await ctx.kept?.())?.some((e) => e.name === name));
}
const holdsAll = async (ctx: NeedsContext, names: readonly string[]) =>
  (await Promise.all(names.map((n) => holds(ctx, n)))).every(Boolean);

/** A minted token is renewed this long before it lapses. */
export const RENEW_WITHIN_MS = 14 * 86_400_000;

/** When `name` lapses, if that is within the renew window; null while it is safe or unknown. */
async function lapsing(ctx: NeedsContext, name: string): Promise<string | null> {
  const kept = (await ctx.kept?.()) ?? [];
  return expiring(kept, RENEW_WITHIN_MS).find((e) => e.name === name)?.expiresAt ?? null;
}

/** Wren's own Google account: its channel, its Pages, its signups. */
const WREN_ADDRESS = "william@wrenautomation.com";

/** Needs derived from the sites: a login credential, the developer app's keys, the consent. */
export function siteNeeds(ctx: NeedsContext): Need[] {
  const out: Need[] = [];
  const seenLogin = new Set<string>();
  for (const s of ctx.sites) {
    const login = consentLoginOf(s);
    const spec = s.setup.find(
      (st): st is SetupStep & { how: { oauth: OAuthSpec } } => "oauth" in st.how,
    );
    const oauth = spec?.how.oauth ?? null;
    // Google logins are per account: the identities table below covers them.
    if (login && login !== "google" && !seenLogin.has(login)) {
      seenLogin.add(login);
      const l = ctx.logins.find((x) => x.site === login);
      const credName = l?.credential ?? login;
      out.push({
        id: `login-${credName}`,
        kind: "credential",
        what: l?.ask ?? `Your ${login} login`,
        unlocks: `signs in for the ${s.site} consent and its browser legs`,
        how: [`autobrowse creds paste ${credName}`],
        check: async () => Boolean(await ctx.credentials.get(credName)),
      });
    }
    if (oauth && spec) {
      const keyNames = [oauth.clientId, oauth.clientSecret];
      const appStep = s.setup.find(
        (st) => !("oauth" in st.how) && st.makes.some((m) => keyNames.includes(m)),
      );
      out.push({
        id: `keys-${s.site}`,
        kind: "keys",
        what: `${s.site}: ${keyNames.join(" + ")} (${appStep?.summary ?? "its developer app"})`,
        unlocks: `the ${s.site} API`,
        how: appStep
          ? [
              `autobrowse site setup ${s.site} ${appStep.name}`,
              `or make the app by hand, put ${keyNames.join(" and ")} in .env, then autobrowse env push ${keyNames.join(" ")}`,
            ]
          : [
              `put ${keyNames.join(" and ")} in .env, then autobrowse env push ${keyNames.join(" ")}`,
            ],
        ...(login && login !== "google"
          ? { after: `login-${ctx.logins.find((x) => x.site === login)?.credential ?? login}` }
          : {}),
        check: () => holdsAll(ctx, keyNames),
      });
      const tokenNames = [oauth.refreshToken, ...(oauth.accessToken ? [oauth.accessToken] : [])];
      out.push({
        id: `consent-${s.site}`,
        kind: "consent",
        what: `${s.site}: a consent (${tokenNames[0]})`,
        unlocks: `${s.site} calls as the site's own account`,
        how: [`autobrowse site setup ${s.site} ${spec.name}`],
        after: `keys-${s.site}`,
        check: async () => (await Promise.all(tokenNames.map((n) => holds(ctx, n)))).some(Boolean),
      });
    } else if ("token" in s.auth) {
      const token = s.auth.token;
      // A step that mints it is the first line: a person copying a token by hand is the fallback.
      const tokenStep = s.setup.find((st) => st.makes.includes(token));
      out.push({
        id: `token-${s.site}`,
        kind: "keys",
        what: `${s.site}: ${token}${tokenStep ? ` (${tokenStep.summary}); reopens 14 days before it lapses` : ""}`,
        unlocks: `the ${s.site} API`,
        how: [
          ...(tokenStep ? [`autobrowse site setup ${s.site} ${tokenStep.name}`] : []),
          `or put ${token} in .env, then autobrowse env push ${token}`,
        ],
        // Present and not about to lapse: a token inside the renew window reopens the row.
        check: async () => (await holds(ctx, token)) && !(await lapsing(ctx, token)),
      });
    }
  }
  return out;
}

/** Needs per account in the policy: its Google credential and a readable inbox. */
export function accountNeeds(ctx: NeedsContext): Need[] {
  const out: Need[] = [];
  for (const id of ctx.identities) {
    if (id.at !== "google") continue;
    const label = id.address.split("@")[0] ?? id.address;
    out.push({
      id: `login-google-${label}`,
      kind: "credential",
      what: `Google login for ${id.address} (${id.for.join(", ") || "no purpose yet"})`,
      unlocks: `consents and "Sign in with Google" as ${id.address}`,
      how: [`autobrowse creds paste google@${label}`],
      check: async () => Boolean(await profileOf(ctx.credentials, "google", id.address)),
    });
    out.push({
      id: `inbox-${label}`,
      kind: "consent",
      what: `${id.address}: its inbox readable (codes for signups and sign-ins)`,
      unlocks: `signups and logins whose codes land at ${id.address}`,
      how: [
        `autobrowse site setup gmail consent --account ${id.address}   (headed, from the UI's headed button: a passkey prompt is yours to pass)`,
        ...(id.address.endsWith("@wrenautomation.com")
          ? [
              "or admin.google.com → Security → API controls → Domain-wide delegation → add https://www.googleapis.com/auth/gmail.readonly, then GOOGLE_WORKSPACE_DOMAIN=wrenautomation.com",
            ]
          : []),
      ],
      after: `login-google-${label}`,
      check: async () =>
        signupInbox(id.address, { env: ctx.env, workspaceDomain: ctx.workspaceDomain }) ||
        (await holds(ctx, accountEnv(gmailOAuth.refreshToken, id.address))),
    });
  }
  return out;
}

/** The hand-kept rest: the phone, this Mac, money, decisions. */
export function fixedNeeds(ctx: NeedsContext): Need[] {
  const out: Need[] = [
    {
      id: "phone-forwarding",
      kind: "phone",
      what: "SMS codes reaching this Mac (Text Message Forwarding + Full Disk Access)",
      unlocks: "signups and logins that text a code (Instagram, X, Twilio)",
      how: [
        "iPhone → Settings → Messages → Text Message Forwarding → this Mac on",
        "System Settings → Privacy & Security → Full Disk Access → the app this runs from",
      ],
      check: async () => (ctx.phone ? (await ctx.phone()).read : false),
    },
    {
      id: "phone-send",
      kind: "phone",
      what: "Messages.app allowed to send (Automation permission)",
      unlocks: "notes and payment-gate questions to your phone",
      how: ["open Messages.app signed in to iMessage; say yes once when the first send asks"],
      check: async () => (ctx.phone ? (await ctx.phone()).send : false),
    },
    {
      id: "mac-accessibility",
      kind: "mac",
      what: "Accessibility for the app this runs from",
      unlocks: "desktop `os` acts (apps, menus, dialogs)",
      how: ["autobrowse desktop setup (opens the pane); add Terminal / iTerm / VS Code"],
      check: async () => (ctx.desktop ? (await ctx.desktop()).accessibility : false),
    },
    {
      id: "mac-root",
      kind: "mac",
      what: "The root helper for `shell {root:true}`",
      unlocks: "root commands from workflows",
      how: ["autobrowse desktop setup, then run the three commands it prints"],
      check: async () => (ctx.desktop ? (await ctx.desktop()).root : false),
    },
    {
      id: "twilio-number",
      kind: "money",
      what: "A Twilio number (TWILIO_NUMBER), if the phone link is not wanted",
      unlocks: "SMS codes without this Mac",
      how: [
        "Twilio console → upgrade → buy a number; TWILIO_NUMBER in .env; autobrowse env push TWILIO_NUMBER",
      ],
      check: () => holds(ctx, "TWILIO_NUMBER"),
    },
    {
      id: "anthropic-credits",
      kind: "money",
      what: "Anthropic API credits ($5 min)",
      unlocks: "the agent explores with the good model (LLM_PROVIDER=claude-code works meanwhile)",
      how: [
        "platform.claude.com/settings/billing → Buy credits",
        "autobrowse needs done anthropic-credits",
      ],
    },
    {
      id: "meta-ad-account-card",
      kind: "money",
      what: "A payment method on the Meta ad account",
      unlocks: "ads that go ACTIVE",
      how: [
        "business.facebook.com → Billing → add a card",
        "autobrowse needs done meta-ad-account-card",
      ],
      after: "keys-meta",
    },
    {
      id: "linkedin-password",
      kind: "credential",
      what: "A LinkedIn password for your account (it signs in with Google today)",
      unlocks:
        "the LinkedIn API: /oauth/v2/authorization always lands on /uas/login and asks for a password, even with a live session — until then posting goes through the composer",
      how: [
        "linkedin.com → Settings → Sign in & security → set or change password (yours to do)",
        "autobrowse creds password linkedin",
      ],
      check: async () => {
        const cred = await ctx.credentials.get("linkedin");
        return Boolean(cred && !cred.via);
      },
    },
    {
      id: "npm-account",
      kind: "credential",
      what: "The npm account itself: npmjs.com/signup on william@wrenautomation.com, then `creds username npm <the username you picked>`",
      unlocks:
        "publishing mailifier, and every later package: once the account exists the token, 2FA and publish are all automatic",
      how: [
        "autobrowse signup npm --by-hand --handle wrenautomation  (opens npmjs.com/signup in your browser, password on the clipboard; clears itself when npm's first mail lands)",
        "why by hand: the page is behind a bot check, and legacy registry signup answers 403 `Account creation via legacy auth is unavailable`",
      ],
      check: async () => Boolean((await ctx.credentials.get("npm"))?.madeAt),
    },
    {
      id: "virtual-cards-vendor",
      kind: "decision",
      what: "Which virtual-card vendor (Privacy.com, or your bank's)",
      unlocks: "one card per site with its own cap, placed like a password",
      how: ["autobrowse needs done virtual-cards-vendor --note <vendor>"],
    },
    {
      id: "facebook-page-owner",
      kind: "decision",
      what: "Which profile the Wren Automation Facebook Page hangs off (yours, or a new one for Wren)",
      unlocks: "Page posts and the Instagram professional account behind it",
      how: ["autobrowse needs done facebook-page-owner --note <yours|new>"],
    },
    {
      id: "youtube-consent-wren",
      kind: "consent",
      what: "A YouTube token for Wren's own channel (the channel exists on william@wrenautomation.com; the stored token is still a personal channel's, and every write is refused until they match)",
      unlocks: "uploads and comments as Wren, not as you",
      how: [
        "autobrowse site setup youtube consent --account william@wrenautomation.com",
        "if Google blocks it: add that address as a test user on the Cloud project's OAuth consent screen first",
      ],
      check: () => holds(ctx, accountEnv(youtubeOAuth.refreshToken, WREN_ADDRESS)),
    },
    {
      id: "linkedin-page",
      kind: "decision",
      what: "Which LinkedIn Page the developer app attaches to (or: make one for Wren Automation)",
      unlocks: "the LinkedIn developer app",
      how: ["autobrowse needs done linkedin-page --note <page|make>"],
    },
    {
      id: "unsubscribe",
      kind: "decision",
      what: "Leave the mailing lists `autobrowse unsubscribe` listed",
      unlocks: "a quiet inbox",
      how: ["autobrowse unsubscribe --yes --only <ids>", "autobrowse needs done unsubscribe"],
    },
  ];
  // A signup inbox is the `signup` account's: say so when none of them is readable yet.
  const signupId = identityFor(ctx.identities, "signup");
  if (signupId)
    out.push({
      id: "signup-inbox",
      kind: "consent",
      what: `A readable inbox for signups (the policy says ${signupId.address})`,
      unlocks: "autobrowse signup instagram|x|tiktok without --email",
      how: [
        `autobrowse site setup gmail consent --account ${signupId.address}`,
        "or autobrowse accounts use signup <an address whose inbox is readable>",
      ],
      check: async () =>
        signupInbox(signupId.address, { env: ctx.env, workspaceDomain: ctx.workspaceDomain }),
    });
  return out;
}

/** The accounts Wren makes itself, and what stopped the agent when it tried. */
export const WREN_SIGNUPS: readonly {
  site: string;
  /** Why the agent's own run handed off, when it did. */
  handoff: string | null;
}[] = [
  { site: "instagram", handoff: null },
  {
    site: "x",
    handoff:
      "email signup is refused (X pushes phone or the app); the phone dialog loops on the number, so a headed run past its check is yours",
  },
  {
    site: "tiktok",
    handoff:
      "the email route fills to the code step, but headless 'Send code' never sends (a silent bot check), so a headed run past it is yours",
  },
];

/** Needs for Wren's own accounts: one per signup not yet stored, plus the profile steps after. */
export function signupNeeds(ctx: NeedsContext): Need[] {
  const out: Need[] = [];
  for (const w of WREN_SIGNUPS) {
    out.push({
      id: `signup-${w.site}`,
      kind: "credential",
      what: `Wren's ${w.site} account${w.handoff ? ` (${w.handoff})` : ""}`,
      unlocks: `posting as Wren on ${w.site}`,
      how: [
        `autobrowse signup ${w.site} --name "Wren Automation" --handle wrenautomation --headed`,
        `autobrowse creds push ${w.site}`,
      ],
      check: async () => Boolean((await ctx.credentials.get(w.site))?.madeAt),
    });
  }
  out.push({
    id: "instagram-professional",
    kind: "decision",
    what: "Make Wren's Instagram a professional (business) account",
    unlocks: "Instagram publishing through the Meta app",
    how: ["Instagram → Settings → Account type and tools → Switch to professional account"],
    after: "signup-instagram",
  });
  return out;
}

export function allNeeds(ctx: NeedsContext): Need[] {
  return [...siteNeeds(ctx), ...accountNeeds(ctx), ...signupNeeds(ctx), ...fixedNeeds(ctx)];
}

/** Decisions and manual steps the person marked done, with a note each. */
export interface DoneMarks {
  [id: string]: { at: string; note?: string };
}
export interface DoneStore {
  read(): DoneMarks;
  mark(id: string, note?: string): void;
  clear(id: string): void;
}
export function fileDone(path: string): DoneStore {
  const file = expandHome(path);
  const read = (): DoneMarks =>
    existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as DoneMarks) : {};
  const write = (m: DoneMarks) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  };
  return {
    read,
    mark(id, note) {
      write({ ...read(), [id]: { at: new Date().toISOString(), ...(note ? { note } : {}) } });
    },
    clear(id) {
      const m = read();
      delete m[id];
      write(m);
    },
  };
}

export interface NeedRow extends Need {
  done: boolean;
  /** Why it is done: the check passed, or the person said so. */
  by: "check" | "you" | null;
  note?: string;
}

/** A row over the wire: the check itself stays here, only whether there is one travels. */
export type NeedView = Omit<NeedRow, "check"> & { checked: boolean };
export function needView(r: NeedRow): NeedView {
  const { check, ...rest } = r;
  return { ...rest, checked: Boolean(check) };
}

export async function resolveNeeds(needs: Need[], marks: DoneMarks): Promise<NeedRow[]> {
  const out: NeedRow[] = [];
  for (const n of needs) {
    const mark = marks[n.id];
    let by: NeedRow["by"] = null;
    if (n.check && (await n.check().catch(() => false))) by = "check";
    else if (mark) by = "you";
    out.push({ ...n, done: by !== null, by, ...(mark?.note ? { note: mark.note } : {}) });
  }
  return out;
}

export const KIND_TITLES: Record<NeedKind, string> = {
  credential: "Logins (creds paste; the clipboard holds `email password [authenticator key]`)",
  keys: "Developer apps and keys",
  consent: "Consents and inboxes",
  phone: "Phone",
  mac: "This Mac",
  money: "Money",
  decision: "Decisions",
};

export function formatNeeds(rows: NeedRow[], o: { all?: boolean } = {}): string {
  const shown = o.all ? rows : rows.filter((r) => !r.done);
  if (!shown.length) return "nothing owed: everything autobrowse needs from you is in hand";
  const doneIds = new Set(rows.filter((r) => r.done).map((r) => r.id));
  const lines: string[] = [];
  for (const kind of Object.keys(KIND_TITLES) as NeedKind[]) {
    const here = shown.filter((r) => r.kind === kind);
    if (!here.length) continue;
    lines.push(`${KIND_TITLES[kind]}`);
    for (const r of here) {
      const wait = r.after && !doneIds.has(r.after) ? ` (after ${r.after})` : "";
      const state = r.done
        ? ` ✓ ${r.by === "you" ? "you said so" : "in hand"}${r.note ? `: ${r.note}` : ""}`
        : "";
      lines.push(`  ${r.id}${wait}${state}`);
      lines.push(`    ${r.what} → ${r.unlocks}`);
      for (const h of r.how) lines.push(`    $ ${h}`);
    }
    lines.push("");
  }
  const open = rows.filter((r) => !r.done).length;
  lines.push(`${open} open, ${rows.length - open} in hand`);
  return lines.join("\n");
}
