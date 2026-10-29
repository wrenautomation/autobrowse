/**
 * Answer and submit one LEARN quiz attempt (`learn/quiz-attempt`), picking
 * each option by its text. The check reads the quiz list first: no attempts
 * left, the submit step skips with no gate. The check never opens the quiz,
 * since an open attempt starts any time limit. The submit is graded work in
 * the student's name, so a person approves the answers first.
 */
import { z } from "zod";
import { learnQuizAttempt, learnQuizzes } from "../../browser/flows/learn.js";
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
  /** The course's org unit: `ou=` in a LEARN URL. */
  ou: z.number().int().positive(),
  /** The quiz: `qi=` in its URL. */
  qi: z.number().int().positive(),
  answers: z
    .array(
      z.object({
        /** "Question 3" is 3. */
        question: z.number().int().positive(),
        /** Option texts to pick, exactly as the quiz shows them. */
        choices: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

export interface Memo {
  quiz?: string;
  /** Why no attempt is left, from the check. */
  spent?: string;
  /** The attempt's score once submitted. */
  score?: string;
}

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

const check: Step<"check"> = {
  name: "check",
  async run({ fx, deps, plan, memo }) {
    const quizzes = await fx.run("browser read quizzes", () =>
      deps.browser.run(learnQuizzes, { ou: plan.ou }),
    );
    const quiz = quizzes.find((q) => q.qi === plan.qi);
    if (!quiz) throw new Error(`course ${plan.ou} has no quiz ${plan.qi}`);
    memo.quiz = quiz.name;
    if (quiz.allowed !== null && quiz.used !== null && quiz.used >= quiz.allowed) {
      memo.spent = `${quiz.used} / ${quiz.allowed} attempts used`;
      return done(`"${quiz.name}": ${memo.spent}`);
    }
    return done(
      `"${quiz.name}": ${quiz.used ?? "?"} / ${quiz.allowed ?? "unlimited"} attempts used`,
    );
  },
};

const submit: Step<"submit"> = {
  name: "submit",
  irreversible: true,
  harmless: (_plan, memo) => !!(memo.spent || memo.score),
  async run({ fx, deps, plan, memo, gate }) {
    if (memo.spent) return skipped(`no attempt left (${memo.spent})`);
    if (memo.score) return skipped(`submitted, scored ${memo.score}`);
    const picks = plan.answers.map((a) => `Q${a.question}: ${a.choices.join(" + ")}`).join("; ");
    const answer = gate("send", `Submit "${memo.quiz}" on LEARN with ${picks}?`);
    if (!answer.approved) return rejected(answer.note ?? "not submitted");
    const { attempt } = await fx.run("browser answer and submit quiz", () =>
      deps.browser.run(learnQuizAttempt, { ...plan, submit: true }),
    );
    memo.score = attempt?.score ?? "not graded yet";
    return done(`submitted; attempt ${attempt?.ai ?? "?"} scored ${memo.score}`);
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "learn-quiz-submit",
  description: "Answer and submit one LEARN (D2L) quiz attempt by option text",
  site: "learn",
  plan: planSchema,
  steps: [check, submit],
  emptyMemo: () => ({}),
});
