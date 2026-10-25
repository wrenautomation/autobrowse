import { describe, expect, it } from "vitest";
import { memoryEffects, runFlow } from "../../index.js";
import {
  type Admin,
  covers,
  memberIds,
  type PageAdminInput,
  type PageAdminOutput,
  planSchema,
  workflow,
} from "./index.js";

const owner: Admin = { name: "Sam Lee", vanity: "sam-lee-owner", role: "Super admin" };
const wren = (role: string): Admin => ({ name: "Sam Lee", vanity: "sam-lee-1a2b3c", role });

/** A browser whose Page has `admins`; an add appends the member as a Content admin, or throws `refuse`. */
const deps = (runs: PageAdminInput[], admins: Admin[] = [owner], refuse?: string) => ({
  browser: {
    run: async (_flow: unknown, input: PageAdminInput): Promise<PageAdminOutput> => {
      runs.push(input);
      if (!input.add) return { admins, outcome: "read" };
      if (!input.add.save)
        return { admins, outcome: "rehearsed", picked: "Sam Lee 3rd+ • Founder, Example Co" };
      if (refuse) throw new Error(refuse);
      return {
        admins: [...admins, wren("Content admin")],
        outcome: "added",
        picked: "Sam Lee 3rd+ • Founder, Example Co",
      };
    },
  } as never,
});
const base = {
  companyId: "1234567",
  vanity: "sam-lee-1a2b3c",
  memberId: "ACoAATest123",
  query: "Sam Lee Founder, Example",
};
const yes = () => ({ approved: true, note: null, at: new Date().toISOString() });
const what = (runs: PageAdminInput[]) =>
  runs.map((r) => (r.add ? (r.add.save ? "add" : "rehearse") : "read"));

describe("linkedin-page-admin", () => {
  it("dry run rehearses the pick and saves nothing", async () => {
    const runs: PageAdminInput[] = [];
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      deps(runs),
      planSchema.parse({ ...base, dryRun: true }),
    );
    expect(out.status).toBe("planned");
    expect(what(runs)).toEqual(["rehearse"]);
    expect(out.results.check?.detail).toContain("rehearsed: picked");
    expect(runs[0]?.add).toMatchObject({
      memberId: "ACoAATest123",
      role: "content",
    });
  });

  it("waits at the send gate, then adds and reads back", async () => {
    const runs: PageAdminInput[] = [];
    const { fx } = memoryEffects();
    const plan = planSchema.parse(base);
    expect((await runFlow(fx, workflow, deps(runs), plan)).status).toBe("waiting");
    const out = await runFlow(fx, workflow, deps(runs), plan, (gate) => {
      expect(gate.name).toBe("send");
      expect(gate.prompt).toContain("Content admin of LinkedIn Page 1234567");
      return yes();
    });
    expect(out.status).toBe("done");
    expect(what(runs)).toEqual(["read", "add"]);
    expect(out.results.add?.detail).toContain("as Content admin, read back");
  });

  it("asks nothing when the member already holds the role or a higher one", async () => {
    const runs: PageAdminInput[] = [];
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      deps(runs, [owner, wren("Super admin")]),
      planSchema.parse(base),
    );
    expect(out.status).toBe("done");
    expect(out.results.add?.detail).toBe("sam-lee-1a2b3c is already Super admin");
    expect(what(runs)).toEqual(["read"]);
  });

  it("fails with LinkedIn's words when it refuses the member", async () => {
    const runs: PageAdminInput[] = [];
    const refusal =
      "LinkedIn refused: This member could not be added as a page admin. Ask the member to verify their account if they have not already, and then try again.";
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      deps(runs, [owner], refusal),
      planSchema.parse(base),
      yes,
    );
    expect(out.status).toBe("failed");
    expect(out.results.add?.detail).toContain("verify their account");
  });
});

describe("page admin helpers", () => {
  it("reads each typeahead element's profile id in order", () => {
    const el = (id: string) => ({
      image: {
        attributes: [
          { detailData: { nonEntityProfilePicture: { "*profile": `urn:li:fsd_profile:${id}` } } },
        ],
      },
    });
    const body = {
      data: {
        data: {
          searchDashReusableTypeaheadByType: {
            elements: [el("ACoAAother1"), { title: "no picture" }, el("ACoAAG2mApcB")],
          },
        },
      },
    };
    expect(memberIds(body)).toEqual(["ACoAAother1", null, "ACoAAG2mApcB"]);
    expect(memberIds(null)).toEqual([]);
  });

  it("ranks roles", () => {
    expect(covers("Super admin", "content")).toBe(true);
    expect(covers("Content admin", "content")).toBe(true);
    expect(covers("Analyst", "content")).toBe(false);
    expect(covers(null, "analyst")).toBe(false);
  });
});
