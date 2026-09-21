import type { BrowserFlow, FlowRunner } from "../src/browser/flow.js";
import { cloudflareBuy } from "../src/browser/flows/cloudflare-buy.js";
import { googleDkimGenerate, googleDkimStart } from "../src/browser/flows/google-dkim.js";
import { instantlyWarmup } from "../src/browser/flows/instantly-warmup.js";
import { NeedsHuman } from "../src/browser/session.js";
import type { CloudflareClient, DnsRecord } from "../src/clients/cloudflare.js";
import type { GateAnswer, GateName } from "../src/engine/effects.js";
import type { RunEvent } from "../src/engine/events.js";
import { memoryEffects } from "../src/engine/memory.js";
import type { OpenGate } from "../src/engine/run.js";
import type { DomainDeps } from "../src/workflows/domain/index.js";

const NOW = "2026-09-19T12:00:00Z";

/** In-memory host with a fixed clock. */
export const fakeEffects = () => memoryEffects({ now: () => new Date(NOW) });

/** Collects what a run object tells the world; `subjects` mirrors the old notify emails. */
export function fakeHost() {
  const events: RunEvent[] = [];
  return {
    events,
    emit: async (e: RunEvent) => {
      events.push(e);
    },
    subjects: () =>
      events.flatMap((e) =>
        e.type === "gate-opened"
          ? [
              `${e.run.key}: ${e.gate.name === "human" ? `needs you at ${e.gate.step}` : `approve ${e.gate.name}?`}`,
            ]
          : e.type === "finished"
            ? [`${e.run.key}: ${e.status}`]
            : [],
      ),
  };
}

/** Scripted gate answers for `runFlow`; records every gate it was asked. */
export function scriptedAnswers(script: Partial<Record<GateName, Array<Partial<GateAnswer>>>>) {
  const asked: string[] = [];
  const answer = (gate: OpenGate): GateAnswer | null => {
    asked.push(gate.name);
    const next = script[gate.name]?.shift();
    if (!next) return null;
    return { approved: true, note: null, at: NOW, ...next };
  };
  return { answer, asked };
}

/** Browser flows by name; a test overrides one to throw NeedsHuman or return something else. */
export function fakeBrowser(calls: string[]) {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const runner: FlowRunner & {
    on: <I, O>(flow: BrowserFlow<I, O>, fn: (input: I) => Promise<O>) => void;
  } = {
    on(flow, fn) {
      handlers.set(flow.name, fn as (input: unknown) => Promise<unknown>);
    },
    async run(flow, input) {
      const h = handlers.get(flow.name);
      if (!h) throw new Error(`no fake for browser flow ${flow.name}`);
      return (await h(input)) as never;
    },
  };
  runner.on(cloudflareBuy, async ({ domain }) => {
    calls.push(`buy ${domain}`);
    return { priceText: "$10.11" };
  });
  runner.on(googleDkimGenerate, async () => {
    calls.push("dkimGenerate");
    return { name: "google._domainkey", value: "v=DKIM1; k=rsa; p=abc" };
  });
  runner.on(googleDkimStart, async () => {
    calls.push("dkimStart");
    return "started";
  });
  runner.on(instantlyWarmup, async ({ email }) => {
    calls.push(`warmup ${email}`);
    return "enrolled";
  });
  return runner;
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
  over: Partial<DomainDeps> & { cloudflare?: ReturnType<typeof fakeCloudflare> } = {},
) {
  const users = new Set<string>();
  const domains = new Map<string, boolean>();
  const calls: string[] = [];
  let roster =
    '# roster\n[[senders]]\naddress = "old@fleet.test"\ndisplay_name = "Old"\nniches = "all"\n';
  const bought = new Set<string>();
  const cloudflare = over.cloudflare ?? fakeCloudflare();
  const deps: Deps & {
    /** Thrown by the next `cloudflare.registered` calls, to exercise the host's error handling. */
    failCheckWith: Error | null;
    /** How many calls throw it; default every call until cleared. */
    failCheckTimes: number;
    calls: string[];
    rosterText: () => string;
    browser: ReturnType<typeof fakeBrowser>;
  } = {
    calls,
    failCheckWith: null,
    failCheckTimes: Number.POSITIVE_INFINITY,
    rosterText: () => roster,
    cloudflare: {
      ...cloudflare,
      // A purchase shows up in the Registrar API afterwards.
      registered: async (d) => {
        if (deps.failCheckWith && deps.failCheckTimes-- > 0) throw deps.failCheckWith;
        return bought.has(d) || cloudflare.registered(d);
      },
    },
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
      async recent() {
        return [];
      },
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
      async deployState() {
        return "success" as const;
      },
      async startLoops(a) {
        calls.push(`loops ${a}`);
        return { send: true, inbox: true };
      },
    },
    availability: async () => "available",
    browser: fakeBrowser(calls),
    secrets: {
      async put(name) {
        calls.push(`secret ${name}`);
      },
    },
    dmarcRua: "dmarc@fleet.test",
    dnsWaitMs: 0,
    ...over,
  };
  deps.browser.on(cloudflareBuy, async ({ domain }) => {
    calls.push(`buy ${domain}`);
    bought.add(domain);
    return { priceText: "$10.11" };
  });
  return deps;
}

export { NeedsHuman };

/** A fetch that records requests and answers from a table by method + path. */
export function fakeFetch(
  answer: (req: { method: string; url: URL; headers: Headers; body: string }) => {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
  },
) {
  const calls: { method: string; url: URL; headers: Headers; body: string }[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const req = {
      method: init?.method ?? "GET",
      url: new URL(url),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : init?.body ? "<bytes>" : "",
    };
    calls.push(req);
    const a = answer(req);
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), {
      status: a.status ?? 200,
      headers: { "content-type": "application/json", ...(a.headers ?? {}) },
    });
  };
  return { calls, fetch };
}
