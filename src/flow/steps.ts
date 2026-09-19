/**
 * The steps of one domain provision, in order. Each is idempotent (get
 * before create) and returns what the next ones need. Outputs live in the
 * memo, which the host persists between steps. A step that runs a browser
 * flow proves the result through an API read afterwards where one exists.
 */
import { randomBytes } from "node:crypto";
import type { FlowRunner } from "../browser/flow.js";
import { cloudflareBuy } from "../browser/flows/cloudflare-buy.js";
import {
  type DkimRecord,
  googleDkimGenerate,
  googleDkimStart,
} from "../browser/flows/google-dkim.js";
import { instantlyWarmup } from "../browser/flows/instantly-warmup.js";
import { NeedsHuman } from "../browser/session.js";
import type { CloudflareClient, DnsRecord } from "../clients/cloudflare.js";
import type { GmailUserClient } from "../clients/gmail.js";
import type { GoogleAdminClient } from "../clients/google-admin.js";
import type { Availability } from "../clients/rdap.js";
import { appendEntries, type RosterStore } from "../clients/roster.js";
import type { WrenClient } from "../clients/wren.js";
import { type Effects, type GateAnswer, type GateName, GateOpen } from "./effects.js";
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

/** Steps that spend money or create something a person would have to undo. */
export const IRREVERSIBLE: ReadonlySet<StepName> = new Set(["buy", "inboxes", "roster", "loops"]);

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
  browser: FlowRunner;
  /** A secret store for inbox passwords (SSM): `put(name, value)`. */
  secrets: { put: (name: string, value: string) => Promise<void> };
  notify: (subject: string, text: string) => Promise<void>;
  dmarcRua: string | null;
  /** How long to keep asking Google to see a TXT before giving the human the wheel. */
  dnsWaitMs?: number;
}

/** What one step returns. The host adds `at` and the artifacts. */
export type StepOutput =
  | { status: "done"; detail: string }
  | { status: "skipped"; detail: string }
  | { status: "rejected"; detail: string };

const done = (detail: string): StepOutput => ({ status: "done", detail });
const skipped = (detail: string): StepOutput => ({ status: "skipped", detail });

export interface StepCtx {
  fx: Effects;
  deps: Deps;
  plan: Plan;
  memo: Memo;
  /** The recorded answer, or `GateOpen` so the host can ask. */
  gate(name: GateName, prompt: string): GateAnswer;
}

export type Step = (ctx: StepCtx) => Promise<StepOutput>;

export const SECRET_PREFIX = "/autobrowse/inboxes";

export const steps: Record<StepName, Step> = {
  async check({ fx, deps, plan, memo }) {
    const owned = await fx.run("cloudflare registered", () =>
      deps.cloudflare.registered(plan.domain),
    );
    memo.owned = owned;
    if (owned) {
      memo.availability = "taken";
      return done("already registered in this Cloudflare account");
    }
    const availability = await fx.run("rdap", () => deps.availability(plan.domain));
    memo.availability = availability;
    if (availability === "taken") throw new Error(`${plan.domain} is registered by someone else`);
    if (availability === "unknown")
      throw new Error(`RDAP could not say whether ${plan.domain} is free`);
    return done("available");
  },

  async buy({ fx, deps, plan, memo, gate }) {
    if (memo.owned) return skipped("already owned");
    if (!plan.buy) throw new Error(`${plan.domain} is not owned and buy=false`);
    const answer = gate(
      "purchase",
      `Buy ${plan.domain} at Cloudflare Registrar (renews yearly at the registrar's cost price)?`,
    );
    if (!answer.approved) return { status: "rejected", detail: answer.note ?? "purchase declined" };
    const bought = await fx.run("cloudflare buy", () =>
      deps.browser.run(cloudflareBuy, { domain: plan.domain }),
    );
    // The dashboard said yes; the API is the proof.
    const registered = await fx.run("cloudflare registered after buy", () =>
      deps.cloudflare.registered(plan.domain),
    );
    if (!registered)
      throw new NeedsHuman(`checkout finished but the Registrar API does not list ${plan.domain}`);
    memo.owned = true;
    return done(`bought${bought.priceText ? ` (${bought.priceText})` : ""}`);
  },

  async zone({ fx, deps, plan, memo }) {
    const existing = await fx.run("zone lookup", () => deps.cloudflare.zoneId(plan.domain));
    memo.zoneId =
      existing ?? (await fx.run("zone create", () => deps.cloudflare.createZone(plan.domain)));
    return done(existing ? `zone ${existing}` : `zone created ${memo.zoneId}`);
  },

  async "workspace-domain"({ fx, deps, plan }) {
    const current = await fx.run("workspace domain get", () => deps.google.getDomain(plan.domain));
    if (current)
      return done(current.verified ? "in Workspace, verified" : "in Workspace, unverified");
    await fx.run("workspace domain add", () => deps.google.addDomain(plan.domain));
    return done("added to Workspace as a secondary domain");
  },

  async "verify-domain"({ fx, deps, plan, memo }) {
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

  async "mail-dns"({ fx, deps, memo }) {
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

  async "dkim-generate"({ fx, deps, plan, memo }) {
    const dkim = await fx.run("dkim generate", () =>
      deps.browser.run(googleDkimGenerate, { domain: plan.domain }),
    );
    if (!/^v=DKIM1;/.test(dkim.value))
      throw new NeedsHuman(`the admin console showed something that is not a DKIM record`);
    memo.dkim = dkim;
    return done(`${dkim.name} (${dkim.value.length} chars)`);
  },

  async "dkim-dns"({ fx, deps, memo }) {
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

  async "dkim-start"({ fx, deps, plan }) {
    // Google needs to see the TXT first; give the resolvers a moment before the first try.
    await fx.sleep(
      deps.dnsWaitMs === undefined ? 2 * 60_000 : Math.min(deps.dnsWaitMs, 2 * 60_000),
    );
    const o = await fx.run("dkim start", () =>
      deps.browser.run(googleDkimStart, { domain: plan.domain }),
    );
    return done(o);
  },

  async inboxes({ fx, deps, plan }) {
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
        await deps.secrets.put(`${SECRET_PREFIX}/${email}/password`, password);
        return existing ? "password reset" : "created";
      });
      outcomes.push(`${email} ${o}`);
    }
    return done(outcomes.join(", "));
  },

  async signatures({ fx, deps, plan }) {
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

  async warmup({ fx, deps, plan }) {
    if (!plan.warmup) return skipped("warmup=false");
    const outcomes: string[] = [];
    for (const inbox of plan.inboxes) {
      const email = inboxAddress(plan, inbox);
      const o = await fx.run(`warmup ${email}`, () => deps.browser.run(instantlyWarmup, { email }));
      outcomes.push(`${email} ${o}`);
    }
    return done(outcomes.join(", "));
  },

  async roster({ fx, deps, plan, memo }) {
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
    const since = await fx.now();
    await fx.run("wren redeploy", () => deps.wren.redeploy());
    const deployed = await pollUntil(fx, "wren deploy", 15 * 60_000, async () => {
      const state = await deps.wren.deployState(since);
      if (state === "failed") throw new Error("wren deploy failed; see its Actions tab");
      return state === "success";
    });
    if (!deployed) throw new Error("wren did not finish deploying in 15 minutes");
    return done(`added ${added.join(", ")}; wren redeployed`);
  },

  async loops({ fx, deps, plan }) {
    if (!plan.handoff) return skipped("handoff=false");
    const outcomes: string[] = [];
    for (const inbox of plan.inboxes) {
      const email = inboxAddress(plan, inbox);
      const o = await fx.run(`loops ${email}`, () => deps.wren.startLoops(email));
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

export { GateOpen };
