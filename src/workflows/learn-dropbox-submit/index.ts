/**
 * Hand one file in to a LEARN dropbox folder (`learn/dropbox-submit`). A
 * folder takes one submission, so the check reads the folder list first:
 * already submitted, the submit step skips with no gate. The submit hands in
 * work in the student's name, so a person approves it first.
 */
import { existsSync } from "node:fs";
import { z } from "zod";
import { learnDropbox, learnDropboxSubmit } from "../../browser/flows/learn.js";
import {
  defineWorkflow,
  done,
  type FlowRunner,
  rejected,
  type StepDef,
  skipped,
} from "../../index.js";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  /** The course's org unit: `ou=` in a LEARN URL (PD 10 Fall 2026 is 1285415). */
  ou: z.number().int().positive(),
  /** The folder: `db=` in its submit URL. */
  db: z.number().int().positive(),
  /** A local file path. */
  file: z.string().min(1),
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

export interface Memo {
  /** The folder's name, from the check. */
  folder?: string;
  /** What the folder list said when it already had a submission. */
  already?: string;
  submissionId?: string;
}

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

const check: Step<"check"> = {
  name: "check",
  async run({ fx, deps, plan, memo }) {
    if (!existsSync(plan.file)) throw new Error(`no file at ${plan.file}`);
    const folders = await fx.run("browser read dropbox folders", () =>
      deps.browser.run(learnDropbox, { ou: plan.ou }),
    );
    const folder = folders.find((f) => f.db === plan.db);
    if (!folder) throw new Error(`course ${plan.ou} has no dropbox folder ${plan.db}`);
    memo.folder = folder.name;
    if (folder.submitted) {
      memo.already = folder.status ?? "submitted";
      return done(`"${folder.name}" already has a submission: ${memo.already}`);
    }
    return done(`"${folder.name}" is open, nothing submitted yet`);
  },
};

const submit: Step<"submit"> = {
  name: "submit",
  irreversible: true,
  harmless: (_plan, memo) => !!(memo.already || memo.submissionId),
  async run({ fx, deps, plan, memo, gate }) {
    if (memo.already) return skipped(`already submitted (${memo.already})`);
    if (memo.submissionId) return skipped(`submitted as ${memo.submissionId}`);
    const answer = gate(
      "send",
      `Hand in ${plan.file} to "${memo.folder}" on LEARN? The folder takes one submission.`,
    );
    if (!answer.approved) return rejected(answer.note ?? "not submitted");
    const { submissionId } = await fx.run("browser submit dropbox file", () =>
      deps.browser.run(learnDropboxSubmit, { ...plan, submit: true }),
    );
    memo.submissionId = submissionId ?? "submitted";
    return done(`submitted; Submission ID ${memo.submissionId}`);
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "learn-dropbox-submit",
  description: "Hand one file in to a LEARN (D2L) dropbox folder, once",
  plan: planSchema,
  steps: [check, submit],
  emptyMemo: () => ({}),
});
