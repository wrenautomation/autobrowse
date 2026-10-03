import { describe, expect, it } from "vitest";
import type { Identity } from "../src/auth/identities.js";
import type { HttpClient } from "../src/clients/http.js";
import { runFlow } from "../src/engine/run.js";
import {
  asDomainPlan,
  type WorkspaceInboxPlan,
  workspaceInboxWorkflow,
} from "../src/workflows/workspace-inbox/index.js";
import { fakeDeps, fakeEffects, scriptedAnswers } from "./fakes.js";

const ADDRESS = "will@fleet.test";

async function setup(o: { verified?: boolean; accounts?: Identity[] } = {}) {
  const domain = fakeDeps();
  if (o.verified !== false) {
    await domain.google.addDomain("fleet.test");
    await domain.google.verifyDomain("fleet.test");
  }
  domain.calls.length = 0;
  const kept = new Set<string>();
  let accounts: Identity[] = o.accounts ?? [];
  const deps = {
    ...domain,
    http: {} as HttpClient,
    identities: {
      list: async () => accounts,
      save: async (all: Identity[]) => {
        domain.calls.push("accounts save");
        accounts = all;
      },
    },
    consents: {
      held: async (site: string, address: string) => kept.has(`${site} ${address}`),
      run: async (site: string, address: string) => {
        domain.calls.push(`consent ${site} ${address}`);
        kept.add(`${site} ${address}`);
        return [`${site.toUpperCase()}_REFRESH_TOKEN__WILL_FLEET_TEST`];
      },
    },
  };
  return { deps, calls: domain.calls, accounts: () => accounts };
}

const plan = (over: Partial<WorkspaceInboxPlan> = {}) =>
  workspaceInboxWorkflow.plan.parse({
    address: ADDRESS,
    givenName: "Will",
    familyName: "Jin",
    signatureHtml: "<b>Will</b>",
    photoUrl: "https://img.test/me.gif",
    ...over,
  });

const run = (deps: Awaited<ReturnType<typeof setup>>["deps"], p = plan()) =>
  runFlow(fakeEffects().fx, workspaceInboxWorkflow, deps, p, scriptedAnswers({}).answer);

describe("workspace-inbox workflow", () => {
  it("makes the user, signs it in, consents Gmail and lists it; sends nothing", async () => {
    const { deps, calls, accounts } = await setup();
    const out = await run(deps);
    expect(out.status).toBe("done");
    expect(calls).toEqual([
      `createUser ${ADDRESS}`,
      `credential google@${ADDRESS}`,
      `signature ${ADDRESS}`,
      "authenticator",
      "photo /tmp/me.gif",
      `consent gmail ${ADDRESS}`,
      "accounts save",
    ]);
    expect(accounts()).toEqual([{ address: ADDRESS, at: "google", for: ["sends"] }]);
    for (const s of ["warmup", "roster", "loops", "subscribe", "confirm"] as const)
      expect(out.results[s]?.status).toBe("skipped");
  });

  it("a rerun keeps what is there", async () => {
    const { deps, calls } = await setup();
    await run(deps);
    // What the real enrolment and upload leave behind.
    const site = `google@${ADDRESS}`;
    const had = await deps.credentials.get(site);
    if (had) await deps.credentials.put(site, { ...had, totpSecret: "SEED" });
    deps.photos.add(ADDRESS);
    calls.length = 0;
    const out = await run(deps);
    expect(out.status).toBe("done");
    expect(out.results.inboxes?.detail).toBe(`${ADDRESS} kept`);
    expect(out.results.consent?.detail).toBe("gmail kept already");
    expect(out.results.account?.detail).toBe("already listed");
    expect(calls).toEqual([`signature ${ADDRESS}`]);
  });

  it("adds its purposes to a row it already had", async () => {
    const { deps, accounts } = await setup({
      accounts: [{ address: ADDRESS, at: "google", for: ["signup"] }],
    });
    const out = await run(deps, plan({ purposes: ["sends"], consents: [] }));
    expect(out.results.account?.detail).toBe("now for signup, sends");
    expect(out.results.consent?.status).toBe("skipped");
    expect(accounts()[0]?.for).toEqual(["signup", "sends"]);
  });

  it("stops at a domain Workspace does not serve", async () => {
    const { deps, calls } = await setup({ verified: false });
    const out = await run(deps);
    expect(out.status).toBe("failed");
    expect(out.results["domain-ready"]?.detail).toMatch(/autobrowse domain fleet\.test/);
    expect(calls).toEqual([]);
  });

  it("handoff puts it on the roster and starts its loops", async () => {
    const { deps, calls } = await setup();
    const out = await run(deps, plan({ handoff: true }));
    expect(out.status).toBe("done");
    expect(calls).toContain("roster write");
    expect(calls).toContain(`loops ${ADDRESS}`);
  });

  it("dry run stops before making the user", async () => {
    const { deps, calls } = await setup();
    const out = await run(deps, plan({ dryRun: true }));
    expect(out.status).toBe("planned");
    expect(out.results.inboxes?.status).toBe("planned");
    expect(calls).toEqual([]);
  });

  it("is the domain workflow's plan for one inbox, buying nothing", () => {
    expect(asDomainPlan(plan())).toMatchObject({
      domain: "fleet.test",
      inboxes: [{ local: "will", givenName: "Will", familyName: "Jin" }],
      buy: false,
      warmup: false,
      handoff: false,
    });
  });
});
