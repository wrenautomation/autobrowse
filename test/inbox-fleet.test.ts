import type { Credential, CredentialStore } from "credvault";
import { describe, expect, it } from "vitest";
import type { AwsDomainClient } from "../src/clients/aws-domain.js";
import type { DnsRecord, DynadotClient } from "../src/clients/dynadot.js";
import type { InboxInsidersClient, OrderRequest } from "../src/clients/inbox-insiders.js";
import { runFlow } from "../src/engine/run.js";
import { inboxFleetWorkflow, WARMUP } from "../src/workflows/inbox-fleet/index.js";
import { loginOf, type MailboxLogins, type Probe } from "../src/workflows/inbox-fleet/steps.js";
import { fakeEffects, fakeInstantly, scriptedAnswers } from "./fakes.js";

const SMTP = "wren-a.test";
const GOOGLE = "wren-b.test";
const R53 = ["ns-1.awsdns-01.com", "ns-2.awsdns-02.net"];
const mail = (d: string): DnsRecord[] => [
  { name: "@", type: "MX", value: `mx.${d}`, priority: 10 },
  { name: "@", type: "TXT", value: "v=spf1 include:mx.test ~all" },
  { name: "_dmarc", type: "TXT", value: "v=DMARC1; p=none" },
  { name: "s1._domainkey", type: "TXT", value: "v=DKIM1; k=rsa; p=AB" },
  { name: "@", type: "A", value: "1.2.3.4" },
];

function world(o: { balance?: number; drop?: string } = {}) {
  const calls: string[] = [];
  const owned = new Set<string>();
  const ns = new Map<string, string[]>();
  const dynadot: DynadotClient = {
    async search(d) {
      return { name: d, available: true, price: 10.88, renewal: 10.88 };
    },
    async owned(d) {
      return owned.has(d);
    },
    async balance() {
      return o.balance ?? 50;
    },
    async register(d) {
      calls.push(`register ${d}`);
      owned.add(d);
    },
    async nameservers(d) {
      return ns.get(d) ?? ["ns1.dynadot.com"];
    },
    async setNameservers(d, list) {
      calls.push(`ns ${d}`);
      ns.set(d, list);
    },
    async records(d) {
      return mail(d).filter((r) => r.type !== o.drop);
    },
  };
  const orders: OrderRequest[] = [];
  const instantly = fakeInstantly(calls);
  const ii: InboxInsidersClient = {
    async check(ds) {
      return ds.map((domain) => ({ domain, available: false }));
    },
    async blacklist(ds) {
      return ds.map((domain) => ({ domain, status: "clean" as const, listedOn: [] }));
    },
    async order(req) {
      orders.push(req);
      for (const d of req.domains)
        for (const n of ["a", "b", "c"])
          instantly.have.set(`${n}@${d}`, { email: `${n}@${d}`, status: 1, warmupStatus: 0 });
      return req.infrastructure_type === "private_smtp"
        ? { run_id: "r1", instant: true }
        : { order_id: "o1", instant: false };
    },
    async run() {
      return { status: "completed" };
    },
    async export() {
      return ["a", "b", "c"].map((n) => ({
        email: `${n}@${SMTP}`,
        smtp_host: "smtp.ii.test",
        smtp_port: 587,
        imap_host: "imap.ii.test",
        imap_port: 993,
        password: "pw",
      }));
    },
  };
  const zoneRecords = new Map<string, DnsRecord[]>();
  const aws: AwsDomainClient = {
    async zone() {
      return { id: "Z1", nameservers: R53 };
    },
    async records() {
      return [];
    },
    async upsert(_z, d, rs) {
      zoneRecords.set(d, [...(zoneRecords.get(d) ?? []), ...rs]);
    },
    async alias(_z, d, name) {
      calls.push(`alias ${name} ${d}`);
    },
    async certificate(d) {
      const valid = zoneRecords.get(d)?.some((r) => r.name.startsWith("_acm")) ?? false;
      return {
        arn: `arn:${d}`,
        status: valid ? "ISSUED" : "PENDING_VALIDATION",
        validation: [
          { name: "_acm1", type: "CNAME", value: "x.acm-validations.aws" },
          { name: "_acm2.www", type: "CNAME", value: "y.acm-validations.aws" },
        ],
      };
    },
    async mask(d) {
      calls.push(`mask ${d}`);
      return { id: "E1", host: "d1.cloudfront.net", status: "InProgress" };
    },
  };
  const txt = (n: string) =>
    mail(n.replace(/^_dmarc\./, ""))
      .filter(
        (r) => r.type === "TXT" && (n.startsWith("_dmarc.") ? r.name === "_dmarc" : r.name === "@"),
      )
      .map((r) => r.value);
  const probe: Probe = {
    ns: async (d) => ns.get(d) ?? ["ns1.dynadot.com"],
    mx: async (d) => [`mx.${d}`],
    txt: async (n) => txt(n),
    page: async () => 200,
  };
  const kept = new Map<string, Credential>();
  const credentials: CredentialStore = {
    get: async (s) => kept.get(s) ?? null,
    put: async (s, c) => {
      kept.set(s, c);
    },
    list: async () => [...kept.keys()],
  };
  const mailboxes: Record<string, MailboxLogins> = {};
  const deps = {
    mailboxes: {
      merge: async (rows: Record<string, MailboxLogins>) => {
        Object.assign(mailboxes, rows);
      },
    },
    dynadot: async () => dynadot,
    inboxInsiders: async () => ii,
    instantly: async () => instantly,
    orderKeys: async () => ({ dynadot: "dk", instantly: "ik" }),
    aws,
    credentials,
    probe,
  };
  return { deps, calls, orders, kept, instantly, mailboxes };
}

const plan = {
  domains: [
    { name: SMTP, mailboxes: "private_smtp" as const },
    { name: GOOGLE, mailboxes: "google_workspace" as const },
  ],
  sender: "Will Jin",
};
const parse = (over: Record<string, unknown> = {}) =>
  inboxFleetWorkflow.plan.parse({ ...plan, ...over });

describe("inbox fleet", () => {
  it("buys, orders, isolates, masks and warms on one purchase yes", async () => {
    const w = world();
    const gates = scriptedAnswers({ purchase: [{}] });
    const out = await runFlow(fakeEffects().fx, inboxFleetWorkflow, w.deps, parse(), gates.answer);
    expect(out.status).toBe("done");
    expect(gates.asked).toEqual(["purchase"]);
    expect(w.calls.filter((c) => c.startsWith("register"))).toEqual([
      `register ${SMTP}`,
      `register ${GOOGLE}`,
    ]);
    expect(w.orders.map((o) => [o.infrastructure_type, o.domains, o.mode])).toEqual([
      ["private_smtp", [SMTP], "full_control"],
      ["google_workspace", [GOOGLE], "full_control"],
    ]);
    expect(new Set(w.orders.map((o) => o.idempotency_key)).size).toBe(2);
    expect(w.calls).toContain(`ns ${SMTP}`);
    expect(w.calls).toContain(`alias www ${GOOGLE}`);
    expect(w.instantly.kept.get(`a@${SMTP}`)).toEqual(WARMUP);
    expect(w.kept.get(`smtp@a@${SMTP}`)).toMatchObject({
      username: `a@${SMTP}`,
      url: "smtp://smtp.ii.test:587",
    });
    expect(w.kept.get(`imap@c@${SMTP}`)?.url).toBe("imap://imap.ii.test:993");
    expect(w.mailboxes[`a@${SMTP}`]?.smtp).toMatchObject({
      host: "smtp.ii.test",
      port: 587,
      user: `a@${SMTP}`,
    });
    expect(Object.keys(w.mailboxes)).toHaveLength(3);
    expect(out.results.credentials?.detail).not.toContain("pw");
  });

  it("dry run prices the domains and stops before buying", async () => {
    const w = world();
    const out = await runFlow(
      fakeEffects().fx,
      inboxFleetWorkflow,
      w.deps,
      parse({ dryRun: true }),
      () => null,
    );
    expect(out.status).toBe("planned");
    expect(out.results.check?.detail).toContain("$10.88");
    expect(w.calls).toEqual([]);
  });

  it("asks for funds before the purchase gate when Dynadot is short", async () => {
    const w = world({ balance: 5 });
    const gates = scriptedAnswers({});
    const out = await runFlow(fakeEffects().fx, inboxFleetWorkflow, w.deps, parse(), gates.answer);
    expect(out.status).toBe("waiting");
    expect(out.results.buy?.detail).toContain("Add $17");
    expect(gates.asked).toEqual(["human"]);
  });

  it("will not move name servers when the copy misses public mail records", async () => {
    const w = world({ drop: "MX" });
    const out = await runFlow(
      fakeEffects().fx,
      inboxFleetWorkflow,
      w.deps,
      parse(),
      scriptedAnswers({ purchase: [{}] }).answer,
    );
    expect(out.status).toBe("waiting");
    expect(out.results.isolate?.detail).toContain(`MX mx.${SMTP}`);
    expect(w.calls.some((c) => c.startsWith("ns "))).toBe(false);
  });
});

describe("loginOf", () => {
  it("reads nested and flat spellings", () => {
    expect(
      loginOf(
        { email: "a@x", smtp: { host: "h", port: 465, username: "u", password: "p" } },
        "smtp",
      ),
    ).toEqual({
      host: "h",
      port: 465,
      username: "u",
      password: "p",
    });
    expect(loginOf({ email: "a@x", imapHost: "i", imap_password: "p" }, "imap")).toMatchObject({
      host: "i",
      port: 993,
      username: "a@x",
    });
  });

  it("names fields, never values, when it cannot map a row", () => {
    expect(() => loginOf({ email: "a@x", secret: "hunter2" }, "smtp")).toThrow(/email, secret/);
    expect(() => loginOf({ email: "a@x", secret: "hunter2" }, "smtp")).not.toThrow(/hunter2/);
  });
});
