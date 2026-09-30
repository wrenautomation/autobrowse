/**
 * The steps of one domain provision, in order. Each is idempotent (get
 * before create) and returns what the next ones need through the memo. A
 * step that runs a browser flow proves the result through an API read
 * afterwards where one exists.
 */
import { randomBytes } from "node:crypto";
import { enrollTotpFlow } from "../../auth/enroll.js";
import { resolveLogin } from "../../auth/login.js";
import { SITE_LOGINS } from "../../auth/sites.js";
import {
  type DkimRecord,
  googleDkimGenerate,
  googleDkimStart,
} from "../../browser/flows/google-dkim.js";
import { googleProfilePhoto } from "../../browser/flows/google-profile-photo.js";
import { googleOauthConsent } from "../../browser/flows/oauth-consent.js";
import { NeedsHuman } from "../../browser/session.js";
import type { DnsRecord, DomainQuote } from "../../clients/cloudflare.js";
import { appendEntries } from "../../clients/roster.js";
import type { Effects } from "../../engine/effects.js";
import { done, rejected, type StepDef, skipped } from "../../engine/workflow.js";
import type { DomainDeps } from "./deps.js";
import { domainIdeas } from "./ideas.js";
import { inboxAddress, type Plan } from "./plan.js";

/** Everything the steps learn that later steps need. Never a password: those go from generation to the credential store inside one journaled step. */
export interface DomainMemo {
  /** Cloudflare's answer for a domain nobody here owns yet: free or not, and the price. */
  quote?: DomainQuote;
  owned?: boolean;
  zoneId?: string;
  verificationToken?: string;
  dkim?: DkimRecord;
  rosterAdded?: string[];
  /** Free look-alikes when the asked-for domain is taken: what `pick` offers. */
  options?: DomainQuote[];
  /** The one a person picked from `options`: the run's domain from then on. */
  picked?: string;
}

/** The plan with the picked domain in it (`Workflow.settle`). */
export const settleDomain = (plan: Plan, memo: DomainMemo): Plan =>
  memo.picked ? { ...plan, domain: memo.picked } : plan;

/** An inbox's credential and browser profile: `google@<email>`. */
export const inboxSite = (email: string) => `google@${email}`;

type Step<S extends string> = StepDef<Plan, DomainDeps, DomainMemo, S>;

export const check: Step<"check"> = {
  name: "check",
  async run({ fx, deps, plan, memo }) {
    const owned = await fx.run("cloudflare registered", () =>
      deps.cloudflare.registered(plan.domain),
    );
    memo.owned = owned;
    if (owned) return done("already registered in this Cloudflare account");
    const [quote] = await fx.run("cloudflare check", () => deps.cloudflare.check([plan.domain]));
    if (!quote) throw new Error(`Cloudflare did not answer for ${plan.domain}`);
    memo.quote = quote;
    if (!quote.registrable && quote.reason === "domain_unavailable" && plan.buy) {
      // Taken: the free look-alikes go to a person to pick from (`pick`).
      const stem = plan.domain.split(".")[0] as string;
      const ideas = domainIdeas([stem]).filter((d) => d !== plan.domain);
      const quotes = await fx.run("cloudflare check look-alikes", () =>
        deps.cloudflare.check(ideas),
      );
      memo.options = quotes
        .filter((q) => q.registrable)
        .sort((a, b) => Number(a.price ?? 1e9) - Number(b.price ?? 1e9))
        .slice(0, 10);
      if (memo.options.length > 0)
        return done(
          `${plan.domain} is taken; ${memo.options.length} free look-alikes to pick from`,
        );
    }
    if (!quote.registrable)
      throw new Error(
        quote.reason === "domain_unavailable"
          ? `${plan.domain} is registered by someone else`
          : `Cloudflare cannot register ${plan.domain}: ${quote.reason ?? "no reason given"}`,
      );
    return done(`available at $${quote.price ?? "?"} (renews $${quote.renewal ?? "?"})`);
  },
};

/** A taken domain: a person picks a look-alike (by number or name), and the run goes on with it. */
export const pick: Step<"pick"> = {
  name: "pick",
  async run({ plan, memo, gate }) {
    if (memo.owned || memo.quote?.registrable) return skipped("nothing to pick");
    const options = memo.options ?? [];
    const list = options
      .map((o, i) => `${i + 1}. ${o.name} $${o.price ?? "?"} (renews $${o.renewal ?? "?"})`)
      .join("\n");
    const answer = gate(
      "choose",
      `${plan.domain} is taken. Reply with the number or name of the one to buy:\n${list}`,
    );
    if (!answer.approved) return rejected(answer.note ?? "none picked");
    const said = (answer.note ?? "").trim().toLowerCase();
    const chosen = options[Number(said) - 1] ?? options.find((o) => o.name === said);
    if (!chosen) throw new Error(`"${said}" is not one of the ${options.length} options`);
    memo.picked = chosen.name;
    memo.quote = chosen;
    return done(`picked ${chosen.name}`);
  },
};

/** Steps that make or use inboxes: a domain with none (a site) stops after its zone. */
export function withInboxes<S extends string>(step: Step<S>): Step<S> {
  return {
    ...step,
    run: (ctx) =>
      ctx.plan.inboxes.length === 0
        ? Promise.resolve(skipped("no inboxes: buy and DNS only"))
        : step.run(ctx),
  };
}

export const buy: Step<"buy"> = {
  name: "buy",
  irreversible: true,
  async run({ fx, deps, plan, memo, gate }) {
    if (memo.owned) return skipped("already owned");
    if (!plan.buy) throw new Error(`${plan.domain} is not owned and buy=false`);
    const q = memo.quote;
    const answer = gate(
      "purchase",
      `Buy ${plan.domain} at Cloudflare Registrar for $${q?.price ?? "?"} (renews $${q?.renewal ?? "?"}/yr), on the account's default card?`,
    );
    if (!answer.approved) return rejected(answer.note ?? "purchase declined");
    // A rerun after a crash must never buy twice: a registration already
    // started is followed, not repeated.
    const started =
      (await fx.run("registration so far", () => deps.cloudflare.registration(plan.domain))) ??
      (await fx.run("cloudflare register", () => deps.cloudflare.register(plan.domain)));
    let state = started;
    for (let waited = 0; !state.completed && waited < 10 * 60_000; waited += 15_000) {
      await fx.sleep(15_000);
      state = await fx.run(`registration ${waited}`, async () => {
        const s = await deps.cloudflare.registration(plan.domain);
        return s ?? { state: "in_progress", completed: false };
      });
    }
    if (state.state !== "succeeded")
      throw new NeedsHuman(
        `registration of ${plan.domain} is ${state.state}; see Domain Registration on the Cloudflare dashboard`,
      );
    const registered = await fx.run("cloudflare registered after buy", () =>
      deps.cloudflare.registered(plan.domain),
    );
    if (!registered)
      throw new NeedsHuman(
        `registration succeeded but the Registrar API does not list ${plan.domain}`,
      );
    memo.owned = true;
    return done(`bought for $${q?.price ?? "?"}`);
  },
};

export const zone: Step<"zone"> = {
  name: "zone",
  async run({ fx, deps, plan, memo }) {
    const existing = await fx.run("zone lookup", () => deps.cloudflare.zoneId(plan.domain));
    memo.zoneId =
      existing ?? (await fx.run("zone create", () => deps.cloudflare.createZone(plan.domain)));
    return done(existing ? `zone ${existing}` : `zone created ${memo.zoneId}`);
  },
};

export const workspaceDomain: Step<"workspace-domain"> = {
  name: "workspace-domain",
  async run({ fx, deps, plan }) {
    const current = await fx.run("workspace domain get", () => deps.google.getDomain(plan.domain));
    if (current)
      return done(current.verified ? "in Workspace, verified" : "in Workspace, unverified");
    await fx.run("workspace domain add", () => deps.google.addDomain(plan.domain));
    return done("added to Workspace as a secondary domain");
  },
};

export const verifyDomain: Step<"verify-domain"> = {
  name: "verify-domain",
  async run({ fx, deps, plan, memo }) {
    const current = await fx.run("workspace domain verified?", () =>
      deps.google.getDomain(plan.domain),
    );
    if (current?.verified) return skipped("already verified");
    const zoneId = need(memo.zoneId, "zoneId");
    const token = await fx.run("verification token", () =>
      deps.google.verificationToken(plan.domain),
    );
    memo.verificationToken = token;
    await fx.run("verification txt", () =>
      deps.cloudflare.upsertRecord(zoneId, { type: "TXT", name: "@", content: token }),
    );
    const verified = await pollUntil(fx, "verify", deps.dnsWaitMs ?? 10 * 60_000, () =>
      deps.google.verifyDomain(plan.domain),
    );
    if (!verified)
      throw new NeedsHuman(
        `Google cannot see the verification TXT for ${plan.domain} yet; check DNS and approve to retry`,
      );
    return done("verified by DNS TXT");
  },
};

export const mailDns: Step<"mail-dns"> = {
  name: "mail-dns",
  async run({ fx, deps, memo }) {
    const zoneId = need(memo.zoneId, "zoneId");
    const records: DnsRecord[] = [
      { type: "MX", name: "@", content: "smtp.google.com", priority: 1 },
      { type: "TXT", name: "@", content: "v=spf1 include:_spf.google.com ~all" },
      {
        type: "TXT",
        name: "_dmarc",
        content: `v=DMARC1; p=none${deps.dmarcRua ? `; rua=mailto:${deps.dmarcRua}` : ""}`,
      },
    ];
    const outcomes: string[] = [];
    for (const r of records) {
      const o = await fx.run(`dns ${r.type} ${r.name}`, () =>
        deps.cloudflare.upsertRecord(zoneId, r, {
          replace: r.type === "MX" || r.name === "_dmarc",
        }),
      );
      outcomes.push(`${r.type} ${r.name} ${o}`);
    }
    return done(outcomes.join(", "));
  },
};

export const dkimGenerate: Step<"dkim-generate"> = {
  name: "dkim-generate",
  async run({ fx, deps, plan, memo }) {
    const dkim = await fx.run("dkim generate", () =>
      deps.browser.run(googleDkimGenerate, { domain: plan.domain }),
    );
    if (!/^v=DKIM1;/.test(dkim.value))
      throw new NeedsHuman("the admin console showed something that is not a DKIM record");
    memo.dkim = dkim;
    return done(`${dkim.name} (${dkim.value.length} chars)`);
  },
};

export const dkimDns: Step<"dkim-dns"> = {
  name: "dkim-dns",
  async run({ fx, deps, memo }) {
    const zoneId = need(memo.zoneId, "zoneId");
    const dkim = need(memo.dkim, "dkim");
    const o = await fx.run("dns TXT dkim", () =>
      deps.cloudflare.upsertRecord(
        zoneId,
        { type: "TXT", name: dkim.name, content: dkim.value },
        { replace: true },
      ),
    );
    return done(`TXT ${dkim.name} ${o}`);
  },
};

export const dkimStart: Step<"dkim-start"> = {
  name: "dkim-start",
  async run({ fx, deps, plan }) {
    // Google needs to see the TXT first; give the resolvers a moment before the first try.
    await fx.sleep(
      deps.dnsWaitMs === undefined ? 2 * 60_000 : Math.min(deps.dnsWaitMs, 2 * 60_000),
    );
    const o = await fx.run("dkim start", () =>
      deps.browser.run(googleDkimStart, { domain: plan.domain }),
    );
    return done(o);
  },
};

export const inboxes: Step<"inboxes"> = {
  name: "inboxes",
  irreversible: true,
  async run({ fx, deps, plan, gate }) {
    const outcomes: string[] = [];
    const emails = plan.inboxes.map((i) => inboxAddress(plan, i));
    // Resetting a password somebody may be using is the `password` guard's call.
    const existing = await fx.run("existing inboxes", async () => {
      const found = await Promise.all(emails.map((e) => deps.google.getUser(e)));
      return emails.filter((_, i) => found[i] !== null);
    });
    if (existing.length > 0) {
      const answer = gate(
        "password",
        `Reset the password of ${existing.join(", ")} to a new random one (stored as google@<inbox>)?`,
      );
      if (!answer.approved) return rejected(answer.note ?? "password reset declined");
    }
    for (const inbox of plan.inboxes) {
      const email = inboxAddress(plan, inbox);
      // One journaled step per inbox: the password exists only inside it and
      // in the credential store. A rerun of an unfinished step resets the
      // password, so the store is never left holding a stale one. A reset
      // keeps the authenticator seed: Google keeps the authenticator too.
      const o = await fx.run(`inbox ${email}`, async () => {
        const password = randomBytes(18).toString("base64url");
        const existing = await deps.google.getUser(email);
        if (existing) await deps.google.setPassword(email, password);
        else
          await deps.google.createUser({
            primaryEmail: email,
            givenName: inbox.givenName,
            familyName: inbox.familyName,
            password,
          });
        const site = inboxSite(email);
        const had = await deps.credentials.get(site);
        await deps.credentials.put(site, {
          ...had,
          username: email,
          password,
          ...(had?.password ? { previousPassword: had.password } : {}),
        });
        return existing ? "password reset" : "created";
      });
      outcomes.push(`${email} ${o}`);
    }
    return done(outcomes.join(", "));
  },
};

export const signatures: Step<"signatures"> = {
  name: "signatures",
  async run({ fx, deps, plan }) {
    if (!plan.signatureHtml) return skipped("no signature in the plan");
    const outcomes: string[] = [];
    for (const inbox of plan.inboxes) {
      const email = inboxAddress(plan, inbox);
      // A just-created user takes a little while to have a mailbox.
      const o = await retry(fx, `signature ${email}`, 5, 30_000, () =>
        deps.gmail.setSignature(email, plan.signatureHtml),
      );
      outcomes.push(`${email} ${o}`);
    }
    return done(outcomes.join(", "));
  },
};

/**
 * Each inbox gets an authenticator: Google asks a new sign-in (a new box,
 * a new IP) to prove itself, and a code we make answers where a phone
 * would otherwise be needed.
 */
export const authenticator: Step<"authenticator"> = {
  name: "authenticator",
  async run({ fx, deps, plan }) {
    const outcomes: string[] = [];
    for (const inbox of plan.inboxes) {
      const email = inboxAddress(plan, inbox);
      const site = inboxSite(email);
      const o = await fx.run(`authenticator ${email}`, async () => {
        if ((await deps.credentials.get(site))?.totpSecret) return "already";
        const login = resolveLogin(SITE_LOGINS, site);
        if (!login) throw new Error("no google login spec");
        return deps.browser.run(enrollTotpFlow(login, deps.credentials), undefined);
      });
      outcomes.push(`${email} ${o}`);
    }
    return done(outcomes.join(", "));
  },
};

/** The plan's picture on each inbox, uploaded in the inbox's own profile (no API keeps a GIF animated). */
export const photo: Step<"photo"> = {
  name: "photo",
  async run({ fx, deps, plan }) {
    const url = plan.photoUrl;
    if (!url) return skipped("no photoUrl in the plan");
    const outcomes: string[] = [];
    for (const inbox of plan.inboxes) {
      const email = inboxAddress(plan, inbox);
      const o = await fx.run(`photo ${email}`, async () => {
        const file = await deps.download(url);
        return deps.browser.run({ ...googleProfilePhoto, site: inboxSite(email) }, { file });
      });
      outcomes.push(`${email} ${o}`);
    }
    return done(outcomes.join(", "));
  },
};

const NO_INSTANTLY_KEY =
  "no INSTANTLY_API_KEY: make one in Instantly (Settings → Integrations → API Keys, scopes accounts:all), add it to the environment and `autobrowse env set INSTANTLY_API_KEY --clipboard`, then approve";

/**
 * Warmup in Instantly (warmup only; sends go through wren). Instantly's
 * OAuth session API gives Google's consent URL; the inbox's own profile
 * consents; Instantly reports the account; warmup goes on. No Instantly
 * login and no dashboard.
 */
export const warmup: Step<"warmup"> = {
  name: "warmup",
  async run({ fx, deps, plan }) {
    if (!plan.warmup) return skipped("warmup=false");
    const instantly = await deps.instantly();
    if (!instantly) throw new NeedsHuman(`warmup: ${NO_INSTANTLY_KEY}`);
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const every = deps.pollMs ?? 5_000;
    const outcomes: string[] = [];
    for (const inbox of plan.inboxes) {
      const email = inboxAddress(plan, inbox);
      // One journaled unit per inbox: Instantly's session lives 10 minutes,
      // so init, consent and the status poll cannot straddle a suspension.
      // A rerun asks Instantly first, so an inbox is never connected twice.
      const o = await fx.run(`warmup ${email}`, async () => {
        const have = await instantly.account(email);
        if (have && have.warmupStatus === 1) return "already warming";
        if (!have) {
          const { sessionId, authUrl } = await instantly.oauthInit();
          await deps.browser.run(
            { ...googleOauthConsent, site: inboxSite(email) },
            { url: authUrl, account: email, passThrough: true },
          );
          for (let i = 0; ; i++) {
            const s = await instantly.oauthStatus(sessionId);
            if (s.status === "success") break;
            if (s.status === "error")
              throw new NeedsHuman(`Instantly refused ${email}: ${s.error} ${s.description}`);
            if (s.status === "expired" || i >= 24)
              throw new Error(`Instantly's session for ${email} ended before Google's consent`);
            await pause(every);
          }
        }
        const job = await instantly.enableWarmup([email]);
        for (let i = 0; i < 12; i++) {
          const state = await instantly.job(job);
          if (state === "success") return have ? "warmup turned on" : "connected, warming";
          if (state === "failed")
            throw new Error(`Instantly could not turn warmup on for ${email}`);
          await pause(every);
        }
        return have ? "warmup asked for" : "connected, warmup asked for";
      });
      outcomes.push(`${email} ${o}`);
    }
    return done(outcomes.join(", "));
  },
};

export const roster: Step<"roster"> = {
  name: "roster",
  irreversible: true,
  async run({ fx, deps, plan, memo }) {
    if (!plan.handoff) return skipped("handoff=false");
    const entries = plan.inboxes.map((i) => ({
      address: inboxAddress(plan, i),
      displayName: `${i.givenName} ${i.familyName}`,
      niches: plan.niches,
    }));
    const added = await fx.run("roster append", async () => {
      const current = await deps.roster.read();
      const next = appendEntries(current, entries);
      if (next.added.length > 0) await deps.roster.write(next.text);
      return next.added;
    });
    memo.rosterAdded = added;
    if (added.length === 0) return done("all inboxes already on the roster");
    const wren = deps.wren;
    if (!wren) return done(`added ${added.join(", ")}; no wren for this owner`);
    const since = await fx.now();
    await fx.run("wren redeploy", () => wren.redeploy());
    const deployed = await pollUntil(fx, "wren deploy", 15 * 60_000, async () => {
      const state = await wren.deployState(since);
      if (state === "failed") throw new Error("wren deploy failed; see its Actions tab");
      return state === "success";
    });
    if (!deployed) throw new Error("wren did not finish deploying in 15 minutes");
    return done(`added ${added.join(", ")}; wren redeployed`);
  },
};

export const loops: Step<"loops"> = {
  name: "loops",
  irreversible: true,
  async run({ fx, deps, plan }) {
    if (!plan.handoff) return skipped("handoff=false");
    const wren = deps.wren;
    if (!wren) return skipped("no wren for this owner");
    const outcomes: string[] = [];
    for (const inbox of plan.inboxes) {
      const email = inboxAddress(plan, inbox);
      const o = await fx.run(`loops ${email}`, () => wren.startLoops(email));
      outcomes.push(`${email} send=${o.send} inbox=${o.inbox}`);
    }
    return done(outcomes.join(", "));
  },
};

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`memo has no ${what}; an earlier step did not run`);
  return value;
}

/** Ask every 30 s inside the budget, sleeping durably between asks. */
export async function pollUntil(
  fx: Effects,
  name: string,
  budgetMs: number,
  check: () => Promise<boolean>,
): Promise<boolean> {
  const stepMs = 30_000;
  for (let waited = 0; ; waited += stepMs) {
    if (await fx.run(`${name} ${waited}`, check)) return true;
    if (waited + stepMs > budgetMs) return false;
    await fx.sleep(stepMs);
  }
}

async function retry<T>(
  fx: Effects,
  name: string,
  times: number,
  gapMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < times; i += 1) {
    try {
      return await fx.run(`${name} #${i + 1}`, fn);
    } catch (err) {
      last = err;
      if (i + 1 < times) await fx.sleep(gapMs);
    }
  }
  throw last;
}
