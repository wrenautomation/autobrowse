import { NeedsHuman } from "../src/browser/session.js";
import type { CloudflareClient, DnsRecord } from "../src/clients/cloudflare.js";
import type { Effects, GateAnswer } from "../src/flow/effects.js";
import type { Deps } from "../src/flow/steps.js";

/** In-memory host: runs effects straight away, answers gates from a script, keeps state in a map. */
export function fakeEffects(gateAnswers: Record<string, GateAnswer[]> = {}) {
  const state = new Map<string, unknown>();
  const gates: string[] = [];
  const runs: string[] = [];
  const fx: Effects = {
    async run(name, fn) {
      runs.push(name);
      return fn();
    },
    async gate(name, _message) {
      gates.push(name);
      const next = gateAnswers[name]?.shift();
      if (!next) throw new Error(`test gave no answer for gate ${name}`);
      return next;
    },
    async get(key) {
      return (state.get(key) as never) ?? null;
    },
    set(key, value) {
      state.set(key, structuredClone(value));
    },
    async sleep() {},
    async now() {
      return new Date("2026-09-19T12:00:00Z");
    },
  };
  return { fx, state, gates, runs };
}

export function fakeCloudflare(opts: { registered?: boolean; zone?: string | null } = {}) {
  const records: Array<DnsRecord & { id: string }> = [];
  let zone = opts.zone === undefined ? null : opts.zone;
  const client: CloudflareClient & { records: typeof records; created: string[] } = {
    records,
    created: [],
    async zoneId() {
      return zone;
    },
    async registered() {
      return opts.registered ?? false;
    },
    async createZone(domain) {
      zone = `zone-${domain}`;
      client.created.push(domain);
      return zone;
    },
    async listRecords(_z, type, name) {
      return records.filter((r) => (!type || r.type === type) && (!name || r.name === name));
    },
    async upsertRecord(_z, record, o = {}) {
      const same = records.find(
        (r) => r.type === record.type && r.name === record.name && r.content === record.content,
      );
      if (same) return "kept";
      const existing = records.find((r) => r.type === record.type && r.name === record.name);
      if (existing && o.replace) {
        existing.content = record.content;
        return "replaced";
      }
      records.push({ ...record, id: `r${records.length + 1}` });
      return "created";
    },
  };
  return client;
}

export function fakeDeps(
  over: Partial<Deps> & { cloudflare?: ReturnType<typeof fakeCloudflare> } = {},
) {
  const users = new Set<string>();
  const domains = new Map<string, boolean>();
  const calls: string[] = [];
  let roster =
    '# roster\n[[senders]]\naddress = "old@fleet.test"\ndisplay_name = "Old"\nniches = "all"\n';
  const notes: string[] = [];
  const deps: Deps & { calls: string[]; notes: string[]; rosterText: () => string } = {
    calls,
    notes,
    rosterText: () => roster,
    cloudflare: over.cloudflare ?? fakeCloudflare(),
    google: {
      async getDomain(d) {
        return domains.has(d) ? { domainName: d, verified: domains.get(d) ?? false } : null;
      },
      async addDomain(d) {
        calls.push(`addDomain ${d}`);
        domains.set(d, false);
        return { domainName: d, verified: false };
      },
      async verificationToken() {
        return "google-site-verification=tok";
      },
      async verifyDomain(d) {
        calls.push(`verify ${d}`);
        domains.set(d, true);
        return true;
      },
      async getUser(e) {
        return users.has(e) ? { primaryEmail: e } : null;
      },
      async createUser(u) {
        calls.push(`createUser ${u.primaryEmail}`);
        users.add(u.primaryEmail);
        return { primaryEmail: u.primaryEmail };
      },
      async setPassword(e) {
        calls.push(`setPassword ${e}`);
      },
    },
    gmail: {
      async setSignature(e) {
        calls.push(`signature ${e}`);
        return "set";
      },
      async send() {},
    },
    roster: {
      async read() {
        return roster;
      },
      async write(t) {
        calls.push("roster write");
        roster = t;
      },
    },
    wren: {
      async redeploy() {
        calls.push("redeploy");
      },
      async awaitDeploy() {
        return true;
      },
      async startLoops(a) {
        calls.push(`loops ${a}`);
        return { send: true, inbox: true };
      },
    },
    availability: async () => "available",
    browser: {
      async buy(d) {
        calls.push(`buy ${d}`);
        return { priceText: "$10.11" };
      },
      async dkimGenerate() {
        calls.push("dkimGenerate");
        return { name: "google._domainkey", value: "v=DKIM1; k=rsa; p=abc" };
      },
      async dkimStart() {
        calls.push("dkimStart");
        return "started";
      },
      async warmup(e) {
        calls.push(`warmup ${e}`);
        return "enrolled";
      },
    },
    secrets: {
      async put(name) {
        calls.push(`secret ${name}`);
      },
    },
    notify: async (subject) => {
      notes.push(subject);
    },
    dmarcRua: "dmarc@fleet.test",
    dnsWaitMs: 0,
    ...over,
  };
  return deps;
}

export { NeedsHuman };
