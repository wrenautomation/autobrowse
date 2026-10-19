/**
 * Create an Anthropic Console API key (no expiry), prove it answers, keep it
 * as a key credential `anthropic@<account>` in the owner's vault, and project
 * the env names. With `replaces` the new key takes over that address (a
 * rotation): it keeps the old one's purposes, via and cap, and the old id
 * goes to `previous`. From the explore recording "anthropic-console-api-key"
 * (2026-09-20), made by hand since: the key is found by its shape, not a
 * paragraph index, and is kept only after `GET /v1/models` (free) accepts it.
 * The key never leaves the flow: not in the journal, not in a step's result.
 */

import { KEY_ACCOUNT, keyAddress, keyId, parseKeyAddress } from "credvault";
import { z } from "zod";
import { KeyError, rotatable, rotateKey } from "../../auth/keys.js";
import type { KeyKeeper } from "../../deps/keys.js";
import {
  defineFlow,
  defineWorkflow,
  done,
  type FlowRunner,
  rejected,
  type StepDef,
  Unrecoverable,
} from "../../index.js";

export const planSchema = z
  .object({
    dryRun: z.boolean().default(false),
    name: z.string().min(1).describe("Key name in the Console, e.g. autobrowse-prod"),
    account: z
      .string()
      .optional()
      .describe(
        "The key's label in the vault (anthropic@<account>): lowercase letters and digits with . and - inside. Defaults to name, which must then pass the same rule",
      ),
    purposes: z
      .array(z.string().min(1))
      .default([])
      .describe("What the key is for: default, bulk, drafts"),
    replaces: z
      .string()
      .optional()
      .describe("A rotation: the address (anthropic@<account>) this key takes over"),
    login: z
      .string()
      .optional()
      .describe("The Anthropic login to sign in with (anthropic@<role>); the main one when absent"),
  })
  .superRefine((p, ctx) => {
    const account = p.account ?? p.name;
    if (!KEY_ACCOUNT.test(account))
      ctx.addIssue({
        code: "custom",
        path: [p.account === undefined ? "name" : "account"],
        message: `"${account}" is not a key label: lowercase letters and digits with . and - inside; set account`,
      });
    if (p.replaces) {
      try {
        parseKeyAddress(p.replaces);
      } catch (e) {
        ctx.addIssue({ code: "custom", path: ["replaces"], message: (e as Error).message });
      }
    }
  });
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
  keys: KeyKeeper;
  /** For the proof call; the global fetch unless given. */
  fetch?: typeof fetch;
}

export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

const KEY = /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/;
const KEYS_PAGE = "https://platform.claude.com/settings/workspaces/default/keys";

/** The Messages API accepts the key: a models list is free and needs no credits. */
export async function keyWorks(key: string, f: typeof fetch = fetch): Promise<boolean> {
  const res = await f("https://api.anthropic.com/v1/models?limit=1", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  return res.ok;
}

export interface CreateKeyInput {
  /** The key's name in the Console. */
  name: string;
  /** The label in the vault: the key is `anthropic@<account>`. */
  account: string;
  purposes: string[];
  /** A rotation: the address the new key takes over. */
  replaces?: string | undefined;
  /** The stored login the browser signs in with; recorded on a new key. */
  via: string;
  keys: KeyKeeper;
  fetch?: typeof fetch;
  now?: () => number;
}

/** What a kept key leaves in the journal: names and ids, never the value. */
export interface KeyMade {
  address: string;
  id: string;
  vendorId: string;
  /** A rotation: the old key's id and Console name. */
  old?: { id: string; vendorId?: string };
  projected: { put: string[]; removed: string[] };
  /** The projection failed after the key was kept: why. A retry would mint a second key, so the flow says it instead of failing. */
  projectFailed?: string;
}

export const createKeyFlow = defineFlow<CreateKeyInput, KeyMade>({
  site: "anthropic",
  name: "create-key",
  async run(fp, input) {
    await fp.open(KEYS_PAGE);
    // The first "Create key" only opens the dialog; the one after the form mints the key.
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Create key" },
      { goal: "open the form" },
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Continue with an API key" },
      { goal: "pick an API key" },
    );
    await fp.act(
      { kind: "fill", value: input.name },
      { role: "textbox", name: "Name" },
      { goal: "name it" },
    );
    await fp.act(
      { kind: "click" },
      { role: "combobox", name: "Expires" },
      { goal: "open Expires" },
    );
    await fp.act({ kind: "click" }, { role: "option", name: "Never" }, { goal: "never expire" });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Create key" },
      { goal: "mint the key", irreversible: true },
    );
    const secret = (await fp.read({ css: "[role=dialog]" })).match(KEY)?.[0];
    if (!secret) throw new Error("no sk-ant key on the dialog");
    if (!(await keyWorks(secret, input.fetch)))
      throw new Error(`the new key "${input.name}" was refused by GET /v1/models; not kept`);
    const { keys } = input;
    const now = (input.now ?? Date.now)();
    let id: string;
    let address: string;
    let old: KeyMade["old"];
    if (input.replaces) {
      const r = await rotateKey(keys, input.replaces, secret, {
        owner: keys.owner,
        vendor: "anthropic",
        now,
        vendorId: input.name,
        via: input.via,
      });
      address = input.replaces;
      id = keyId(r.key.secret);
      old = r.old;
    } else {
      const made = await keys.put({
        site: "anthropic",
        account: input.account,
        owner: keys.owner,
        secret,
        via: input.via,
        vendorId: input.name,
        purposes: input.purposes,
        status: "live",
        madeAt: new Date(now).toISOString(),
      });
      address = keyAddress(made.site, made.account);
      id = keyId(made.secret);
    }
    // The key is kept; the env names follow it. A failed projection does not fail the flow: the
    // vault holds the key, and a retry would mint another. `autobrowse creds key project` finishes it.
    let projected = { put: [] as string[], removed: [] as string[] };
    let projectFailed: string | undefined;
    try {
      projected = await keys.project(["anthropic"]);
    } catch (err) {
      projectFailed = err instanceof Error ? err.message : String(err);
    }
    await fp.act({ kind: "click" }, { role: "button", name: "Done" }, { goal: "close the dialog" });
    return {
      address,
      id,
      vendorId: input.name,
      ...(old ? { old } : {}),
      projected,
      ...(projectFailed ? { projectFailed } : {}),
    };
  },
});

/** The address this run writes: the one it replaces, else `anthropic@<account>`. */
const addressOf = (plan: Plan): string =>
  plan.replaces ?? keyAddress("anthropic", plan.account ?? plan.name);

const accountOf = (plan: Plan): string =>
  plan.replaces ? parseKeyAddress(plan.replaces).account : (plan.account ?? plan.name);

/** Said before the browser opens: the old key exists and is Anthropic's and this owner's, or the new address is free. */
async function checkTarget(keys: KeyKeeper, plan: Plan): Promise<void> {
  try {
    if (plan.replaces) {
      await rotatable(keys, plan.replaces, { owner: keys.owner, vendor: "anthropic" });
      if (plan.account && plan.account !== accountOf(plan))
        throw new KeyError(400, `account ${plan.account} is not the label of ${plan.replaces}`);
      return;
    }
    const there = await keys.get(addressOf(plan));
    if (there)
      throw new KeyError(400, `${addressOf(plan)} is already a key: set replaces to rotate it`);
  } catch (e) {
    if (e instanceof KeyError) throw new Unrecoverable(e.message);
    throw e;
  }
}

const checkKey: Step<"check-key"> = {
  name: "check-key",
  async run({ fx, deps, plan }) {
    await fx.run("check key", () => checkTarget(deps.keys, plan));
    return done(
      plan.replaces
        ? `${plan.replaces} exists; the new key will replace it`
        : `${addressOf(plan)} is free`,
    );
  },
};

const createKey: Step<"create-key"> = {
  name: "create-key",
  irreversible: true,
  async run({ fx, deps, plan, gate }) {
    const address = addressOf(plan);
    const answer = gate(
      "send",
      plan.replaces
        ? `Create Anthropic API key "${plan.name}" and keep it as ${address}, replacing the key there?`
        : `Create Anthropic API key "${plan.name}" and keep it as ${address}?`,
    );
    if (!answer.approved) return rejected(answer.note ?? "declined");
    const site = plan.login ?? "anthropic";
    const made = await fx.run("browser create-key", async () =>
      deps.browser.run(
        // The same flow under the login that was named (`anthropic@<role>`).
        site === createKeyFlow.site ? createKeyFlow : { ...createKeyFlow, site },
        {
          name: plan.name,
          account: accountOf(plan),
          purposes: plan.purposes,
          replaces: plan.replaces,
          via: await deps.keys.login(site),
          keys: deps.keys,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        },
      ),
    );
    const env = [
      made.projected.put.length ? `put ${made.projected.put.join(", ")}` : "",
      made.projected.removed.length ? `removed ${made.projected.removed.join(", ")}` : "",
    ].filter(Boolean);
    const envNote = made.projectFailed
      ? `the projection failed (${made.projectFailed}): run autobrowse creds key project`
      : `env: ${env.join("; ") || "no change"}`;
    const kept = `key "${plan.name}" answers GET /v1/models; kept as ${made.address} (id ${made.id}); ${envNote}`;
    if (!made.old) return done(kept);
    const oldName = made.old.vendorId
      ? `revoke "${made.old.vendorId}"`
      : `revoke the old key (id ${made.old.id})`;
    return done(`${kept}; ${oldName} at ${KEYS_PAGE} by hand`);
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "anthropic-console-api-key",
  description:
    "Create an Anthropic Console API key (no expiry), prove it answers, keep it as a key credential; with replaces, rotate that one.",
  plan: planSchema,
  steps: [checkKey, createKey],
  emptyMemo: () => ({}),
});
