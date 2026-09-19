/**
 * The steps of one domain provision, in order. Each is idempotent (get
 * before create) and returns what the next ones need. Outputs live in the
 * memo, which the host persists between steps; re-running the flow skips
 * steps already `done` and re-tries the rest.
 */
import { randomBytes } from "node:crypto";
import type { DkimRecord } from "../browser/google-dkim.js";
import { NeedsHuman } from "../browser/session.js";
import type { CloudflareClient, DnsRecord } from "../clients/cloudflare.js";
import type { GmailUserClient } from "../clients/gmail.js";
import type { GoogleAdminClient } from "../clients/google-admin.js";
import type { Availability } from "../clients/rdap.js";
import { appendEntries, type RosterStore } from "../clients/roster.js";
import type { WrenClient } from "../clients/wren.js";
import type { Effects } from "./effects.js";
import { inboxAddress, type Plan } from "./plan.js";

export const STEPS = [
  "check",
  "buy",
  "zone",
  "workspace-domain",
  "verify-domain",
  "mail-dns",
  "dkim-generate",
  "dkim-dns",
  "dkim-start",
  "inboxes",
  "signatures",
  "warmup",
  "roster",
  "loops",
] as const;
export type StepName = (typeof STEPS)[number];

export type StepStatus = "done" | "skipped" | "planned" | "needs-human" | "rejected" | "failed";

export interface StepResult {
  status: StepStatus;
  detail: string;
  at: string;
  /** Where to look when a browser step needs a human. */
  screenshot?: string;
}

/** Everything the steps learn that later steps need. Never a password: those go from generation to the secret store inside one journaled step. */
export interface Memo {
  availability?: Availability;
  owned?: boolean;
  zoneId?: string;
  verificationToken?: string;
  dkim?: DkimRecord;
  rosterAdded?: string[];
}

export interface Deps {
  cloudflare: CloudflareClient;
  google: GoogleAdminClient;
  gmail: GmailUserClient;
  roster: RosterStore;
  wren: WrenClient;
  availability: (domain: string) => Promise<Availability>;
  /** Browser flows, each behind one function so tests can fake them. */
  browser: {
    buy: (domain: string) => Promise<{ priceText: string | null }>;
    dkimGenerate: (domain: string) => Promise<DkimRecord>;
    dkimStart: (domain: string) => Promise<"started" | "already">;
    warmup: (email: string) => Promise<"enrolled" | "already">;
  };
  /** A secret store for inbox passwords (SSM): `put(name, value)`. */
  secrets: { put: (name: string, value: string) => Promise<void> };
  notify: (subject: string, text: string) => Promise<void>;
  dmarcRua: string | null;
  /** How long to keep asking Google to see a TXT before giving the human the wheel. */
  dnsWaitMs?: number;
}

export const MEMO = "memo";
export const RESULTS = "results";

const done = (detail: string, at: Date): StepResult => ({
  status: "done",
  detail,
  at: at.toISOString(),
});
const skipped = (detail: string, at: Date): StepResult => ({
  status: "skipped",
  detail,
  at: at.toISOString(),
});

type Step = (ctx: StepCtx) => Promise<StepResult>;

interface StepCtx {
  fx: Effects;
  deps: Deps;
  plan: Plan;
  memo: Memo;
  now: Date;
}

export const IRREVERSIBLE: ReadonlySet<StepName> = new Set(["buy", "inboxes", "roster", "loops"]);

const steps: Record<StepName, Step> = {
  async check({ fx, deps, plan, memo, now }) {
    const owned = await fx.run("cloudflare registered", () =>
      deps.cloudflare.registered(plan.domain),
    );
    memo.owned = owned;
    if (owned) {
      memo.availability = "taken";
      return done("already registered in this Cloudflare account", now);
    }
    const availability = await fx.run("rdap", () => deps.availability(plan.domain));
    memo.availability = availability;
    if (availability === "taken") throw new Error(`${plan.domain} is registered by someone else`);
    if (availability === "unknown")
      throw new Error(`RDAP could not say whether ${plan.domain} is free`);
    return done("available", now);
  },

  async buy({ fx, deps, plan, memo, now }) {
    if (memo.owned) return skipped("already owned", now);
    if (!plan.buy) throw new Error(`${plan.domain} is not owned and buy=false`);
    const answer = await fx.gate(
      "purchase",
      `Buy ${plan.domain} at Cloudflare Registrar (renews yearly at the registrar's cost price)?`,
    );
    if (!answer.approved)
      return {
        status: "rejected",
        detail: answer.note ?? "purchase declined",
        at: now.toISOString(),
      };
    const bought = await fx.run("cloudflare buy", () => deps.browser.buy(plan.domain));
    memo.owned = true;
    return done(`bought${bought.priceText ? ` (${bought.priceText})` : ""}`, now);
  },

  async zone({ fx, deps, plan, memo, now }) {
    const existing = await fx.run("zone lookup", () => deps.cloudflare.zoneId(plan.domain));
    memo.zoneId =
      existing ?? (await fx.run("zone create", () => deps.cloudflare.createZone(plan.domain)));
    return done(existing ? `zone ${existing}` : `zone created ${memo.zoneId}`, now);
  },

  async "workspace-domain"({ fx, deps, plan, now }) {
    const current = await fx.run("workspace domain get", () => deps.google.getDomain(plan.domain));
    if (current)
      return done(current.verified ? "in Workspace, verified" : "in Workspace, unverified", now);
    await fx.run("workspace domain add", () => deps.google.addDomain(plan.domain));
    return done("added to Workspace as a secondary domain", now);
  },

  async "verify-domain"({ fx, deps, plan, memo, now }) {
    const current = await fx.run("workspace domain verified?", () =>
      deps.google.getDomain(plan.domain),
    );
    if (current?.verified) return skipped("already verified", now);
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
    return done("verified by DNS TXT", now);
  },

  async "mail-dns"({ fx, deps, memo, now }) {
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
    return done(outcomes.join(", "), now);
  },

  async "dkim-generate"({ fx, deps, plan, memo, now }) {
    memo.dkim = await fx.run("dkim generate", () => deps.browser.dkimGenerate(plan.domain));
    return done(`${memo.dkim.name} (${memo.dkim.value.length} chars)`, now);
  },

  async "dkim-dns"({ fx, deps, memo, now }) {
    const zoneId = need(memo.zoneId, "zoneId");
    const dkim = need(memo.dkim, "dkim");
    const o = await fx.run("dns TXT dkim", () =>
      deps.cloudflare.upsertRecord(
        zoneId,
        { type: "TXT", name: dkim.name, content: dkim.value },
        { replace: true },
      ),
    );
    return done(`TXT ${dkim.name} ${o}`, now);
  },

  async "dkim-start"({ fx, deps, plan, now }) {
    // Google needs to see the TXT first; give the resolvers a moment before the first try.
    await fx.sleep(
      deps.dnsWaitMs === undefined ? 2 * 60_000 : Math.min(deps.dnsWaitMs, 2 * 60_000),
    );
    const o = await fx.run("dkim start", () => deps.browser.dkimStart(plan.domain));
    return done(o, now);
  },

  async inboxes({ fx, deps, plan, now }) {
    const outcomes: string[] = [];
    for (const inbox of plan.inboxes) {
      const email = inboxAddress(plan, inbox);
      // One journaled step per inbox: the password exists only inside it and
      // in the secret store. A rerun of an unfinished step resets the
      // password, so the store is never left holding a stale one.
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
        await deps.secrets.put(`/provision/inboxes/${email}/password`, password);
        return existing ? "password reset" : "created";
      });
      outcomes.push(`${email} ${o}`);
    }
    return done(outcomes.join(", "), now);
  },

  async signatures({ fx, deps, plan, now }) {
    if (!plan.signatureHtml) return skipped("no signature in the plan", now);
    const outcomes: string[] = [];
    for (const inbox of plan.inboxes) {
      const email = inboxAddress(plan, inbox);
      // A just-created user takes a little while to have a mailbox.
      const o = await retry(fx, `signature ${email}`, 5, 30_000, () =>
        deps.gmail.setSignature(email, plan.signatureHtml),
      );
      outcomes.push(`${email} ${o}`);
    }
    return done(outcomes.join(", "), now);
  },

  async warmup({ fx, deps, plan, now }) {
    if (!plan.warmup) return skipped("warmup=false", now);
    const outcomes: string[] = [];
    for (const inbox of plan.inboxes) {
      const email = inboxAddress(plan, inbox);
      const o = await fx.run(`warmup ${email}`, () => deps.browser.warmup(email));
      outcomes.push(`${email} ${o}`);
    }
    return done(outcomes.join(", "), now);
  },

  async roster({ fx, deps, plan, memo, now }) {
    if (!plan.handoff) return skipped("handoff=false", now);
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
    if (added.length === 0) return done("all inboxes already on the roster", now);
    const since = await fx.now();
    await fx.run("wren redeploy", () => deps.wren.redeploy());
    const deployed = await pollUntil(fx, "wren deploy", 15 * 60_000, async () => {
      const state = await deps.wren.deployState(since);
      if (state === "failed") throw new Error("wren deploy failed; see its Actions tab");
      return state === "success";
    });
    if (!deployed) throw new Error("wren did not finish deploying in 15 minutes");
    return done(`added ${added.join(", ")}; wren redeployed`, now);
  },

  async loops({ fx, deps, plan, now }) {
    if (!plan.handoff) return skipped("handoff=false", now);
    const outcomes: string[] = [];
    for (const inbox of plan.inboxes) {
      const email = inboxAddress(plan, inbox);
      const o = await fx.run(`loops ${email}`, () => deps.wren.startLoops(email));
      outcomes.push(`${email} send=${o.send} inbox=${o.inbox}`);
    }
    return done(outcomes.join(", "), now);
  },
};

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`memo has no ${what}; an earlier step did not run`);
  return value;
}

async function pollUntil(
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

export interface RunOutcome {
  status: "done" | "planned" | "needs-human" | "rejected" | "failed";
  results: Partial<Record<StepName, StepResult>>;
  memo: Memo;
}

/**
 * Walk the steps. Already-done steps are skipped, so a rerun after a
 * human fix or a crash resumes where it stopped. A dry run plans up to the
 * first irreversible step and stops there.
 */
export async function runFlow(fx: Effects, deps: Deps, plan: Plan): Promise<RunOutcome> {
  const results: Partial<Record<StepName, StepResult>> = (await fx.get(RESULTS)) ?? {};
  const memo: Memo = (await fx.get(MEMO)) ?? {};
  const save = () => {
    fx.set(RESULTS, results);
    fx.set(MEMO, memo);
  };
  for (const name of STEPS) {
    const prior = results[name];
    if (prior && (prior.status === "done" || prior.status === "skipped")) continue;
    const now = await fx.now();
    if (plan.dryRun && IRREVERSIBLE.has(name)) {
      results[name] = {
        status: "planned",
        detail: "dry run stops before the first irreversible step",
        at: now.toISOString(),
      };
      save();
      return { status: "planned", results, memo };
    }
    try {
      results[name] = await steps[name]({ fx, deps, plan, memo, now });
    } catch (err) {
      if (err instanceof NeedsHuman) {
        results[name] = {
          status: "needs-human",
          detail: err.message,
          at: now.toISOString(),
          ...(err.screenshot ? { screenshot: err.screenshot } : {}),
        };
        save();
        await deps.notify(
          `provision ${plan.domain}: needs you at ${name}`,
          `${err.message}\n${err.screenshot ?? ""}\n\nWhen done: provision approve ${plan.domain} human`,
        );
        const answer = await fx.gate("human", err.message);
        if (!answer.approved) {
          results[name] = {
            status: "rejected",
            detail: answer.note ?? "declined",
            at: now.toISOString(),
          };
          save();
          return { status: "rejected", results, memo };
        }
        // Retry the same step once the human is done.
        delete results[name];
        save();
        return runFlow(fx, deps, plan);
      }
      results[name] = {
        status: "failed",
        detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        at: now.toISOString(),
      };
      save();
      return { status: "failed", results, memo };
    }
    save();
    if (results[name]?.status === "rejected") return { status: "rejected", results, memo };
  }
  return { status: "done", results, memo };
}
