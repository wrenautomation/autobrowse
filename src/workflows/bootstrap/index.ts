/**
 * The credential ladder for one provider: sign in with what the store
 * has, mint what the API clients need, write it where the worker reads
 * it. After this runs, the domain workflow has its `CLOUDFLARE_*`.
 * `envKey` mints a second token beside it (another tool's permissions)
 * without touching the first.
 */
import { z } from "zod";
import type { FlowRunner } from "../../browser/flow.js";
import {
  cloudflareAccountId,
  cloudflareApiToken,
  type TokenPermission,
} from "../../browser/flows/cloudflare-token.js";
import type { SecretSink } from "../../deps/sink.js";
import { defineWorkflow, done, type StepDef, skipped } from "../../engine/workflow.js";

export const CLOUDFLARE_PERMISSIONS: TokenPermission[] = [
  { scope: "Zone", name: "Zone", level: "Edit" },
  { scope: "Zone", name: "DNS", level: "Edit" },
  { scope: "Account", name: "Registrar: Domains", level: "Admin" },
];

export const bootstrapPlan = z.object({
  provider: z.literal("cloudflare").describe("Whose credentials to mint"),
  tokenName: z
    .string()
    .min(1)
    .default("autobrowse")
    .describe("The API token's name on the dashboard"),
  permissions: z
    .array(
      z.object({
        scope: z.string().describe("Account or Zone"),
        name: z.string().describe("The permission, as the dashboard lists it"),
        level: z.string().describe("Read, Edit or Admin"),
      }),
    )
    .default(CLOUDFLARE_PERMISSIONS)
    .describe("One row per permission on the token"),
  envKey: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .default("CLOUDFLARE_API_TOKEN")
    .describe("Where the token is stored; another key keeps autobrowse's own token untouched"),
  force: z
    .boolean()
    .default(false)
    .describe("Mint a new token even when one is already configured"),
  dryRun: z.boolean().default(false),
});
export type BootstrapPlan = z.infer<typeof bootstrapPlan>;

export interface BootstrapDeps {
  browser: FlowRunner;
  sink: SecretSink;
  /** What the worker has now, so a finished ladder is a no-op. */
  current: () => { cloudflareAccountId: string | null };
  /** The token stored under a key now, if any. */
  stored: (key: string) => Promise<string | null>;
  /** The API's own verdict on a token; the page saying so is not proof. */
  verifyCloudflareToken: (token: string) => Promise<boolean>;
}

export interface BootstrapMemo {
  accountId?: string;
}

type Step<S extends string> = StepDef<BootstrapPlan, BootstrapDeps, BootstrapMemo, S>;

const accountId: Step<"account-id"> = {
  name: "account-id",
  async run({ fx, deps, plan, memo }) {
    const have = deps.current().cloudflareAccountId;
    if (have && !plan.force) {
      memo.accountId = have;
      return skipped("already configured");
    }
    const { accountId } = await fx.run("cloudflare account id", () =>
      deps.browser.run(cloudflareAccountId, undefined),
    );
    await fx.run("write CLOUDFLARE_ACCOUNT_ID", () =>
      deps.sink.put("CLOUDFLARE_ACCOUNT_ID", accountId),
    );
    memo.accountId = accountId;
    return done(`account ${accountId.slice(0, 6)}…`);
  },
};

const apiToken: Step<"api-token"> = {
  name: "api-token",
  // Creates a credential; a dry run stops here.
  irreversible: true,
  async run({ fx, deps, plan }) {
    const have = await fx.run(`read ${plan.envKey}`, () => deps.stored(plan.envKey));
    if (
      have &&
      !plan.force &&
      (await fx.run("verify existing token", () => deps.verifyCloudflareToken(have)))
    )
      return skipped("existing token verifies");
    // Mint, verify and store inside one effect: the token exists only here and in the sink.
    const outcome = await fx.run("cloudflare api token", async () => {
      const { token } = await deps.browser.run(cloudflareApiToken, {
        name: plan.tokenName,
        permissions: plan.permissions,
      });
      if (!(await deps.verifyCloudflareToken(token))) return "minted a token the API rejects";
      await deps.sink.put(plan.envKey, token);
      return "ok";
    });
    if (outcome !== "ok") throw new Error(outcome);
    return done(`token "${plan.tokenName}" minted, verified, stored as ${plan.envKey}`);
  },
};

export const bootstrapWorkflow = defineWorkflow<BootstrapDeps, BootstrapMemo>()({
  name: "bootstrap",
  description: "Mint the API credentials a provider's workflows need and store them",
  plan: bootstrapPlan,
  steps: [accountId, apiToken],
  emptyMemo: () => ({}),
});
