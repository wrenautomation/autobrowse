/**
 * Point a domain at the main site: every URL on it 301s to `redirectTo`.
 * Proxied placeholder A records at the apex and www (Cloudflare answers,
 * nothing behind them) plus one forwarding page rule. Stands alone for a
 * domain that already has a zone; `sender-domain` runs it after `domain`.
 */
import { z } from "zod";
import { defineWorkflow, done, type StepCtx, type StepDef } from "../../engine/workflow.js";
import type { DomainDeps } from "../domain/deps.js";
import { planSchema as domainPlan } from "../domain/plan.js";

export const MAIN_SITE = "https://wrenautomation.com";
/** RFC 5737 TEST-NET: never routed, so only Cloudflare's proxy ever answers for it. */
export const PLACEHOLDER_IP = "192.0.2.1";

/** The fields the redirect steps read; `sender-domain` adds them to the domain plan. */
export const redirectFields = {
  redirectTo: z.string().url().default(MAIN_SITE).describe("Where every URL on the domain 301s to"),
};

export const redirectPlanSchema = z.object({
  domain: domainPlan.shape.domain,
  ...redirectFields,
  dryRun: z.boolean().default(false),
});

export type RedirectPlan = z.infer<typeof redirectPlanSchema>;
export type RedirectDeps = Pick<DomainDeps, "cloudflare">;
export interface RedirectMemo {
  zoneId?: string;
}

type Fields = Pick<RedirectPlan, "domain" | "redirectTo" | "dryRun">;

/** The zone the domain flow already found, else Cloudflare's; a domain not on Cloudflare stops here. */
async function zoneOf({ fx, deps, plan, memo }: StepCtx<Fields, RedirectDeps, RedirectMemo>) {
  if (!memo.zoneId) {
    const found = await fx.run("zone lookup", () => deps.cloudflare.zoneId(plan.domain));
    if (!found)
      throw new Error(`${plan.domain} has no Cloudflare zone; run the domain workflow first`);
    memo.zoneId = found;
  }
  return memo.zoneId;
}

/** The two steps, typed for whichever workflow carries them (this one, `sender-domain`). */
export function redirectSteps<P extends Fields, D extends RedirectDeps, M extends RedirectMemo>() {
  const dns: StepDef<P, D, M, "redirect-dns"> = {
    name: "redirect-dns",
    async run(ctx) {
      const zoneId = await zoneOf(ctx);
      const { fx, deps, plan } = ctx;
      const out: string[] = [];
      for (const name of ["@", "www"]) {
        // A real site at this name stays: the redirect never clobbers one.
        const held = await fx.run(`records at ${name}`, async () => [
          ...(await deps.cloudflare.listRecords(zoneId, "A", name)),
          ...(await deps.cloudflare.listRecords(zoneId, "CNAME", name)),
        ]);
        const other = held.find((r) => r.content !== PLACEHOLDER_IP);
        if (other)
          throw new Error(
            `${name === "@" ? plan.domain : `www.${plan.domain}`} already points at ${other.content}; remove it to redirect`,
          );
        const r = await fx.run(`A ${name}`, () =>
          deps.cloudflare.upsertRecord(zoneId, {
            type: "A",
            name,
            content: PLACEHOLDER_IP,
            proxied: true,
          }),
        );
        out.push(`${name} ${r}`);
      }
      return done(`proxied A ${out.join(", ")}`);
    },
  };
  const rule: StepDef<P, D, M, "redirect-rule"> = {
    name: "redirect-rule",
    async run(ctx) {
      const zoneId = await zoneOf(ctx);
      const { fx, deps, plan } = ctx;
      const from = `*${plan.domain}/*`;
      const r = await fx.run("page rule", () =>
        deps.cloudflare.setRedirect(zoneId, { from, to: plan.redirectTo }),
      );
      const live = await fx.run("page rule read", () => deps.cloudflare.redirects(zoneId));
      if (!live.some((x) => x.from === from && x.to === plan.redirectTo))
        throw new Error(`Cloudflare does not show ${from} → ${plan.redirectTo} after setting it`);
      return done(`${from} → ${plan.redirectTo} (301, ${r})`);
    },
  };
  return [dns, rule] as const;
}

export const redirectWorkflow = defineWorkflow<RedirectDeps, RedirectMemo>()({
  name: "redirect",
  description: "301 every URL on a domain to the main site (proxied A records + a page rule)",
  plan: redirectPlanSchema,
  steps: redirectSteps(),
  emptyMemo: () => ({}),
});

export type RedirectWorkflow = typeof redirectWorkflow;
