/**
 * The fleet's steps, in order. Each reads before it writes, so a rerun
 * picks up where the last one stopped. The two that spend ask first and
 * never charge twice: `buy` asks Dynadot whether it holds the domain inside
 * the same effect that registers it, `order` sends a key derived from the
 * domains (Inbox Insiders answers a repeat with `duplicate`). A run's gate
 * answers are run-wide, so `buy`'s prompt names the mailbox order too: one
 * yes covers both.
 */
import { createHash } from "node:crypto";
import { NeedsHuman } from "../../browser/session.js";
import type { DnsRecord } from "../../clients/dynadot.js";
import { InboxInsidersError } from "../../clients/inbox-insiders.js";
import type { WarmupSettings } from "../../clients/instantly.js";
import { Unrecoverable } from "../../engine/effects.js";
import { done, rejected, type StepDef, skipped } from "../../engine/workflow.js";
import { pollUntil } from "../domain/steps.js";
import type { FleetDeps, Plan } from "./index.js";

const PER_DOMAIN = 3;
const MAILBOX_USD = 3.5;

/**
 * Instantly warmup on every fleet inbox, in whole percents: +1 a day from
 * 0 to 21 (three weeks), every warmup mail answered, every one that lands
 * in spam pulled out, a third marked important. It never turns off.
 */
export const WARMUP: WarmupSettings = {
  warmup: {
    limit: 21,
    increment: "1",
    reply_rate: 100,
    advanced: {
      open_rate: 85,
      important_rate: 30,
      spam_save_rate: 100,
      read_emulation: true,
      warm_ctd: false,
      weekday_only: false,
    },
  },
};

/** Public DNS and the web as a stranger sees them. */
export interface Probe {
  ns(domain: string): Promise<string[]>;
  mx(domain: string): Promise<string[]>;
  /** Each TXT record at the name, its strings joined. */
  txt(name: string): Promise<string[]>;
  /** The status, redirects not followed. */
  page(url: string): Promise<number>;
}

type Kind = Plan["domains"][number]["mailboxes"];

export interface FleetMemo {
  /** Dynadot's price per domain this account does not hold yet. */
  prices?: Record<string, { price: number | null; renewal: number | null }>;
  orders?: { kind: Kind; domains: string[]; key: string; runId?: string; orderId?: string }[];
  zones?: Record<string, { id: string; nameservers: string[] }>;
}

type Step<S extends string> = StepDef<Plan, FleetDeps, FleetMemo, S>;

const LABEL: Record<Kind, string> = { private_smtp: "SMTP", google_workspace: "Google" };
const names = (plan: Plan) => plan.domains.map((d) => d.name);
const host = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.map(host).every((x) => b.map(host).includes(x));
const usd = (n: number) => `$${n.toFixed(2)}`;

async function client<T>(get: () => Promise<T | null>, key: string): Promise<T> {
  const c = await get();
  if (!c) throw new NeedsHuman(`no ${key}: \`autobrowse env set ${key}\`, then approve`);
  return c;
}

function groups(plan: Plan): { kind: Kind; domains: string[]; key: string }[] {
  return (["private_smtp", "google_workspace"] as const)
    .map((kind) => {
      const domains = plan.domains
        .filter((d) => d.mailboxes === kind)
        .map((d) => d.name)
        .sort();
      const key = `fleet-${kind}-${createHash("sha256").update(domains.join(",")).digest("hex").slice(0, 16)}`;
      return { kind, domains, key };
    })
    .filter((g) => g.domains.length > 0);
}

const monthly = (plan: Plan) => plan.domains.length * PER_DOMAIN * MAILBOX_USD;
const orderLine = (plan: Plan) =>
  `${plan.domains.length * PER_DOMAIN} mailboxes at Inbox Insiders (${groups(plan)
    .map((g) => `${g.domains.length * PER_DOMAIN} ${LABEL[g.kind]} on ${g.domains.join(", ")}`)
    .join("; ")}): ${usd(monthly(plan))}/mo on the saved card, uploaded to Instantly`;

export const check: Step<"check"> = {
  name: "check",
  async run({ fx, deps, plan, memo }) {
    const dyn = await client(deps.dynadot, "DYNADOT_API_KEY");
    const ii = await client(deps.inboxInsiders, "INBOX_INSIDERS_API_KEY");
    const prices: NonNullable<FleetMemo["prices"]> = {};
    const lines: string[] = [];
    for (const d of names(plan)) {
      if (await fx.run(`owned ${d}`, () => dyn.owned(d))) {
        lines.push(`${d} ours`);
        continue;
      }
      const q = await fx.run(`price ${d}`, () => dyn.search(d));
      if (!q.available) throw new Error(`${d} is taken`);
      prices[d] = { price: q.price, renewal: q.renewal };
      lines.push(`${d} ${usd(q.price ?? 0)} (renews ${usd(q.renewal ?? 0)})`);
    }
    const lists = await fx.run("blocklists", () => ii.blacklist(names(plan)));
    const major = lists.filter((l) => l.status === "flagged_major");
    if (major.length > 0)
      throw new Error(
        `blocklisted: ${major.map((l) => `${l.domain} on ${l.listedOn.join(", ")}`).join("; ")}`,
      );
    const minor = lists.filter((l) => l.status !== "clean").map((l) => `${l.domain} ${l.status}`);
    memo.prices = prices;
    return done(
      [...lines, minor.length > 0 ? `lists: ${minor.join(", ")}` : "on no blocklist"].join("; "),
    );
  },
};

export const buy: Step<"buy"> = {
  name: "buy",
  irreversible: true,
  harmless: (_plan, memo) => Object.keys(memo.prices ?? {}).length === 0,
  async run({ fx, deps, plan, memo, gate }) {
    const toBuy = Object.entries(memo.prices ?? {});
    if (toBuy.length === 0) return skipped("every domain is ours");
    const dyn = await client(deps.dynadot, "DYNADOT_API_KEY");
    const total = toBuy.reduce((n, [, p]) => n + (p.price ?? 0), 0);
    const renews = toBuy.reduce((n, [, p]) => n + (p.renewal ?? 0), 0);
    // Registration draws on the prepaid balance, never a card.
    const balance = await fx.run("dynadot balance", () => dyn.balance());
    if (balance < total)
      throw new NeedsHuman(
        `Dynadot holds ${usd(balance)}; the domains cost ${usd(total)}. Add ${usd(Math.ceil(total - balance))} or more (dynadot.com → Account → Add funds), then approve`,
      );
    const answer = gate(
      "purchase",
      `Buy ${toBuy.map(([d, p]) => `${d} ${usd(p.price ?? 0)}`).join(", ")} at Dynadot: ${usd(total)} from the balance, renews ${usd(renews)}/yr. Then order ${orderLine(plan)}. One yes covers both.`,
    );
    if (!answer.approved) return rejected(answer.note ?? "purchase declined");
    for (const [d] of toBuy)
      await fx.run(`register ${d}`, async () => {
        if (!(await dyn.owned(d))) await dyn.register(d);
      });
    const missing: string[] = [];
    for (const [d] of toBuy)
      if (!(await fx.run(`owned after ${d}`, () => dyn.owned(d)))) missing.push(d);
    if (missing.length > 0)
      throw new NeedsHuman(`Dynadot does not list ${missing.join(", ")} after registering`);
    memo.prices = {};
    return done(`bought ${toBuy.map(([d]) => d).join(", ")} for ${usd(total)}`);
  },
};

export const order: Step<"order"> = {
  name: "order",
  irreversible: true,
  harmless: (plan, memo) => groups(plan).every((g) => memo.orders?.some((o) => o.key === g.key)),
  async run({ fx, deps, plan, memo, gate }) {
    const ii = await client(deps.inboxInsiders, "INBOX_INSIDERS_API_KEY");
    const todo = groups(plan).filter((g) => !memo.orders?.some((o) => o.key === g.key));
    if (todo.length === 0) return skipped("ordered already");
    const answer = gate("purchase", `Order ${orderLine(plan)}?`);
    if (!answer.approved) return rejected(answer.note ?? "order declined");
    const keys = await deps.orderKeys();
    memo.orders ??= [];
    for (const g of todo) {
      const a = await fx.run(`order ${g.kind}`, async () => {
        try {
          return await ii.order({
            mode: "full_control",
            infrastructure_type: g.kind,
            domains: g.domains,
            sender_name: plan.sender,
            website_url: plan.site,
            ...(plan.brand ? { brand_name: plan.brand } : {}),
            domain_registrar: "dynadot",
            dynadot_api_key: keys.dynadot,
            cold_email: { provider: "instantly", api_key: keys.instantly },
            idempotency_key: g.key,
          });
        } catch (err) {
          // The retry after either reuses the same key: a charge that went through answers `duplicate`.
          if (err instanceof InboxInsidersError && err.status === 402)
            throw new NeedsHuman(
              `Inbox Insiders ${err.code}: fix the card at inboxinsiders.io/settings#billing, then approve`,
            );
          if (err instanceof InboxInsidersError && err.status === 422)
            throw new Unrecoverable(err.message);
          throw err;
        }
      });
      memo.orders.push({
        kind: g.kind,
        domains: g.domains,
        key: g.key,
        ...(a.run_id ? { runId: a.run_id } : {}),
        ...(a.order_id ? { orderId: a.order_id } : {}),
      });
    }
    return done(
      memo.orders
        .map(
          (o) =>
            `${LABEL[o.kind]} ${o.domains.join(", ")}: ${o.runId ? `run ${o.runId}` : "with their team"}`,
        )
        .join("; "),
    );
  },
};

/** Every order done and its mailboxes in Instantly. Google orders are set up by hand on their side (a day or two). */
export const ready: Step<"ready"> = {
  name: "ready",
  async run({ fx, deps, memo }) {
    const ii = await client(deps.inboxInsiders, "INBOX_INSIDERS_API_KEY");
    const instantly = await client(deps.instantly, "INSTANTLY_API_KEY");
    const orders = memo.orders ?? [];
    for (const o of orders) {
      const runId = o.runId;
      if (!runId) continue;
      const finished = await pollUntil(fx, `run ${runId}`, 45 * 60_000, async () => {
        const { status } = await ii.run(runId);
        if (status === "failed")
          throw new NeedsHuman(
            `Inbox Insiders run ${runId} failed: ask inboxinsiders.io/support with the run id, then approve`,
          );
        return status.startsWith("completed");
      });
      if (!finished)
        throw new NeedsHuman(
          `run ${runId} still going after 45 min: ask inboxinsiders.io/support, approve when done`,
        );
    }
    const emails = await fx.run("instantly inboxes", async () =>
      (await instantly.accounts()).map((a) => a.email),
    );
    const short = orders
      .flatMap((o) => o.domains)
      .filter((d) => emails.filter((e) => e.endsWith(`@${d}`)).length < PER_DOMAIN);
    if (short.length > 0)
      throw new NeedsHuman(
        `Instantly lacks mailboxes on ${short.join(", ")}. Google orders are built by Inbox Insiders' team (inboxinsiders.io/orders); approve once they show in Instantly`,
      );
    return done(`${orders.flatMap((o) => o.domains).length * PER_DOMAIN} mailboxes in Instantly`);
  },
};

/**
 * Each domain onto its own Route 53 zone: Dynadot's records copied over,
 * then the name servers moved. Public DNS (still Dynadot's) checks the
 * copy first: a missed MX, SPF or DMARC would drop mail.
 */
export const isolate: Step<"isolate"> = {
  name: "isolate",
  irreversible: true,
  async run({ fx, deps, plan, memo }) {
    const dyn = await client(deps.dynadot, "DYNADOT_API_KEY");
    memo.zones ??= {};
    const lines: string[] = [];
    for (const d of names(plan)) {
      const zone = await fx.run(`zone ${d}`, () => deps.aws.zone(d));
      memo.zones[d] = zone;
      if (sameSet(await fx.run(`ns ${d}`, () => dyn.nameservers(d)), zone.nameservers)) {
        lines.push(`${d} on Route 53 already`);
        continue;
      }
      const records = (await fx.run(`dynadot dns ${d}`, () => dyn.records(d))).filter(
        (r) => !maskOwns(r),
      );
      const lost = await fx.run(`public dns ${d}`, () => missedBy(records, d, deps.probe));
      if (lost.length > 0)
        throw new NeedsHuman(
          `${d}: the copy from Dynadot misses ${lost.join(", ")}; moving name servers now would break mail. Check DNS at Dynadot, then approve`,
        );
      await fx.run(`copy ${d}`, () => deps.aws.upsert(zone.id, d, records));
      await fx.run(`set ns ${d}`, () => dyn.setNameservers(d, zone.nameservers));
      lines.push(`${d}: ${records.length} records, ${zone.nameservers.join(" ")}`);
    }
    return done(lines.join("; "));
  },
};

/** Apex and www web records: the mask writes its own. */
const maskOwns = (r: DnsRecord) =>
  (r.name === "@" || r.name === "www") && ["A", "AAAA", "CNAME", "NS", "SOA"].includes(r.type);

/** What public DNS serves that the copy lacks: MX hosts, apex TXT, DMARC, and any DKIM at all. */
export async function missedBy(records: DnsRecord[], d: string, probe: Probe): Promise<string[]> {
  const has = (name: string, type: string, value: string) =>
    records.some(
      (r) =>
        r.name === name && r.type === type && host(r.value.replace(/^"|"$/g, "")) === host(value),
    );
  const [mx, txt, dmarc] = await Promise.all([probe.mx(d), probe.txt(d), probe.txt(`_dmarc.${d}`)]);
  const lost = [
    ...(mx.length === 0 ? ["any MX (none public yet)"] : []),
    ...mx.filter((h) => !has("@", "MX", h)).map((h) => `MX ${h}`),
    ...txt.filter((t) => !has("@", "TXT", t)).map((t) => `TXT ${t.slice(0, 40)}`),
    ...dmarc.filter((t) => !has("_dmarc", "TXT", t)).map(() => "DMARC"),
  ];
  if (!records.some((r) => r.name.endsWith("_domainkey"))) lost.push("DKIM");
  return lost;
}

/** CloudFront shows the site under each domain's own name: certificate, distribution, apex and www aliases. */
export const mask: Step<"mask"> = {
  name: "mask",
  async run({ fx, deps, plan, memo }) {
    const origin = new URL(plan.site).hostname;
    const lines: string[] = [];
    for (const d of names(plan)) {
      const zone = memo.zones?.[d];
      if (!zone) throw new Error(`memo has no zone for ${d}; isolate did not run`);
      let cert = await fx.run(`cert ${d}`, () => deps.aws.certificate(d));
      // ACM names the validation records a few seconds after the request: apex and www.
      for (let i = 0; cert.status !== "ISSUED" && cert.validation.length < 2; i++) {
        if (i >= 10) throw new Error(`ACM gave no validation records for ${d}`);
        await fx.sleep(30_000);
        cert = await fx.run(`cert ${d} ${i}`, () => deps.aws.certificate(d));
      }
      if (cert.status !== "ISSUED") {
        const validation = cert.validation;
        await fx.run(`validation ${d}`, () => deps.aws.upsert(zone.id, d, validation));
        const issued = await pollUntil(
          fx,
          `issued ${d}`,
          30 * 60_000,
          async () => (await deps.aws.certificate(d)).status === "ISSUED",
        );
        if (!issued)
          throw new NeedsHuman(
            `ACM has not issued ${d}'s certificate in 30 min; approve to wait again`,
          );
      }
      const arn = cert.arn;
      const dist = await fx.run(`cloudfront ${d}`, () => deps.aws.mask(d, origin, arn));
      for (const name of ["@", "www"])
        await fx.run(`alias ${name} ${d}`, () => deps.aws.alias(zone.id, d, name, dist.host));
      lines.push(`${d} shows ${origin} via ${dist.host}`);
    }
    return done(lines.join("; "));
  },
};

/** What a stranger sees: Route 53's name servers, MX, SPF, DMARC, and the site. Name server caches can lag an hour. */
export const verify: Step<"verify"> = {
  name: "verify",
  async run({ fx, deps, plan, memo }) {
    for (const d of names(plan)) {
      const ns = memo.zones?.[d]?.nameservers ?? [];
      const ok = await pollUntil(
        fx,
        `public ${d}`,
        60 * 60_000,
        async () => (await problems(d, ns, deps.probe)).length === 0,
      );
      if (!ok) {
        const why = await fx.run(`why ${d}`, () => problems(d, ns, deps.probe));
        throw new NeedsHuman(`${d}: ${why.join(", ")}; approve to check again`);
      }
    }
    return done(`${names(plan).join(", ")}: Route 53, MX, SPF, DMARC, site 200`);
  },
};

async function problems(d: string, ns: string[], probe: Probe): Promise<string[]> {
  const [pub, mx, txt, dmarc, page] = await Promise.all([
    probe.ns(d),
    probe.mx(d),
    probe.txt(d),
    probe.txt(`_dmarc.${d}`),
    probe.page(`https://${d}/`).catch(() => 0),
  ]);
  return [
    ...(sameSet(pub, ns) ? [] : ["name servers not Route 53's yet"]),
    ...(mx.length > 0 ? [] : ["no MX"]),
    ...(txt.some((t) => t.startsWith("v=spf1")) ? [] : ["no SPF"]),
    ...(dmarc.some((t) => t.startsWith("v=DMARC1")) ? [] : ["no DMARC"]),
    ...(page === 200 ? [] : [`site answers ${page || "nothing"}`]),
  ];
}

export const warmup: Step<"warmup"> = {
  name: "warmup",
  async run({ fx, deps, plan }) {
    const instantly = await client(deps.instantly, "INSTANTLY_API_KEY");
    const emails = await fx.run("fleet inboxes", async () =>
      (await instantly.accounts())
        .map((a) => a.email)
        .filter((e) => names(plan).some((d) => e.endsWith(`@${d}`))),
    );
    if (emails.length === 0) throw new Error("Instantly has no inbox on these domains");
    for (const e of emails) await fx.run(`settings ${e}`, () => instantly.setSettings(e, WARMUP));
    const job = await fx.run("warmup on", () => instantly.enableWarmup(emails));
    const on = await pollUntil(fx, "warmup job", 10 * 60_000, async () => {
      const state = await instantly.job(job);
      if (state === "failed") throw new Unrecoverable("Instantly could not turn warmup on");
      return state === "success";
    });
    return done(
      `${emails.length} inboxes warming, +1/day to 21${on ? "" : " (Instantly's job still running)"}`,
    );
  },
};

/** SMTP and IMAP logins into the credential store as `smtp@<email>` and `imap@<email>`. Google logins come as a CSV on their orders page. */
export const credentials: Step<"credentials"> = {
  name: "credentials",
  async run({ fx, deps, memo }) {
    const runs = (memo.orders ?? []).flatMap((o) => (o.runId ? [o.runId] : []));
    const google = (memo.orders ?? []).filter((o) => !o.runId).flatMap((o) => o.domains);
    const tail =
      google.length > 0
        ? `; Google logins for ${google.join(", ")} at inboxinsiders.io/orders`
        : "";
    if (runs.length === 0) return skipped(`no SMTP order${tail}`);
    const ii = await client(deps.inboxInsiders, "INBOX_INSIDERS_API_KEY");
    let stored = 0;
    // Passwords go from the export into the store inside one effect; only a count is journaled.
    for (const runId of runs)
      stored += await fx.run(`store ${runId}`, async () => {
        let n = 0;
        for (const m of await ii.export(runId))
          for (const proto of ["smtp", "imap"] as const) {
            const site = `${proto}@${m.email}`;
            if (await deps.credentials.get(site)) continue;
            const login = loginOf(m, proto);
            await deps.credentials.put(site, {
              username: login.username,
              password: login.password,
              url: `${proto}://${login.host}:${login.port}`,
            });
            n++;
          }
        return n;
      });
    return done(`${stored} logins stored${tail}`);
  },
};

/** One protocol's login from an export row, whichever of the usual spellings it uses. Never a value in an error: field names only. */
export function loginOf(
  m: Record<string, unknown>,
  proto: "smtp" | "imap",
): { host: string; port: number; username: string; password: string } {
  const nested = (m[proto] ?? {}) as Record<string, unknown>;
  const pick = (k: string, ...fallback: string[]) => {
    for (const v of [
      nested[k],
      m[`${proto}_${k}`],
      m[`${proto}${k[0]?.toUpperCase()}${k.slice(1)}`],
      ...fallback.map((f) => m[f]),
    ])
      if ((typeof v === "string" && v !== "") || typeof v === "number") return String(v);
    return "";
  };
  const host = pick("host", `${proto}_server`);
  const port = Number(pick("port")) || (proto === "smtp" ? 587 : 993);
  const username = pick("username", "username", "email");
  const password = pick("password", "password");
  if (!host || !password)
    throw new Unrecoverable(
      `export rows carry ${Object.keys(m).join(", ")}: map ${proto} host and password in loginOf`,
    );
  return { host, port, username, password };
}
