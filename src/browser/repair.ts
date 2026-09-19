/**
 * When a locator no longer matches, a repairer looks at the page and
 * proposes another set of hints for the same goal. The proposal is data
 * (hints), never code and never an action: the flow re-applies it through
 * the same `locate` and does the same op. An irreversible op is never
 * repaired; it goes to a person. Every repair is reported so the flow's
 * source can be fixed for good.
 */
import type { Page } from "playwright";
import { z } from "zod";
import { completeJson, type Llm } from "../llm/types.js";
import type { Memory } from "../memory/types.js";
import type { Hints } from "./locate.js";

export interface RepairRequest {
  site: string;
  /** What the step is trying to do, in words: "click Purchase". */
  goal: string;
  failed: Hints;
  url: string;
  /** Interactive elements on the page, one per line, already truncated. */
  snapshot: string;
}

export interface RepairProposal {
  hints: Hints;
  reason: string;
}

export interface Repairer {
  readonly id: string;
  propose(req: RepairRequest): Promise<RepairProposal | null>;
}

export interface RepairReport extends RepairProposal {
  site: string;
  flow: string;
  goal: string;
  failed: Hints;
  url: string;
  ok: boolean;
}

const SNAPSHOT_LIMIT = 200;

/** Interactive elements as the recorder would describe them: cheap to send, enough to choose. */
const SNAPSHOT_SCRIPT = `(max) => {
  const trim = (s) => (s ? s.replace(/\\s+/g, " ").trim().slice(0, 60) : "");
  const out = [];
  for (const e of document.querySelectorAll("a, button, input, select, textarea, [role], summary")) {
    if (out.length >= max) break;
    const rect = e.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    const attr = (n) => e.getAttribute(n);
    out.push([
      e.tagName.toLowerCase(),
      attr("role") ? "role=" + attr("role") : "",
      attr("type") ? "type=" + attr("type") : "",
      e.id ? "id=" + e.id : "",
      attr("data-testid") ? "testId=" + attr("data-testid") : "",
      attr("aria-label") ? "aria=" + trim(attr("aria-label")) : "",
      attr("placeholder") ? "placeholder=" + trim(attr("placeholder")) : "",
      trim(e.textContent) ? "text=" + trim(e.textContent) : "",
    ].filter(Boolean).join(" "));
  }
  return out;
}`;

/** Interactive elements as the recorder would describe them: cheap to send, enough to choose. Plain JS: it runs in the page. */
export async function snapshotPage(page: Page, limit = SNAPSHOT_LIMIT): Promise<string> {
  const rows = await page
    .evaluate<string[]>(`(${SNAPSHOT_SCRIPT})(${limit})`)
    .catch(() => [] as string[]);
  return rows.join("\n");
}

const proposalSchema = z.object({
  hints: z.object({
    tag: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    placeholder: z.string().nullable().optional(),
    id: z.string().nullable().optional(),
    testId: z.string().nullable().optional(),
  }),
  reason: z.string(),
  /** The model may say the goal cannot be met on this page. */
  giveUp: z.boolean().optional(),
});

const SYSTEM = `You repair a broken browser automation step. You get the goal, the locator hints that no longer match, and a list of the interactive elements on the page now. Pick the one element that serves the goal and describe it with hints: testId, role + name, name (label), placeholder, text, or id. Prefer stable, visible labels. If nothing on the page serves the goal, set giveUp true.`;

export function llmRepairer(llm: Llm): Repairer {
  return {
    id: `llm:${llm.id}`,
    async propose(req) {
      const { value } = await completeJson(llm, proposalSchema, {
        system: SYSTEM,
        prompt: [
          `Goal: ${req.goal}`,
          `URL: ${req.url}`,
          `Failed hints: ${JSON.stringify(req.failed)}`,
          "Elements:",
          req.snapshot,
          'Reply: {"hints": {...}, "reason": "...", "giveUp": false}',
        ].join("\n"),
        maxTokens: 400,
      });
      if (value.giveUp) return null;
      const hints: Hints = {};
      for (const [k, v] of Object.entries(value.hints))
        if (v) (hints as Record<string, string>)[k] = v;
      return { hints, reason: value.reason };
    },
  };
}

/** Repairs nothing; the default when no model is configured. */
export const noRepairer: Repairer = { id: "none", propose: async () => null };

/**
 * Remembers repairs that worked and offers them first. Recall is by site
 * and goal, so the second time a page changes the fix costs no model
 * call. Misses fall through to `next`; every success is written back by
 * `learn`, which the runner calls with the report.
 */
export interface LearningRepairer extends Repairer {
  learn(report: RepairReport): Promise<void>;
}

export const canLearn = (r: Repairer): r is LearningRepairer => "learn" in r;

const HINT_MARK = "hints=";

export function rememberingRepairer(memory: Memory, next: Repairer): LearningRepairer {
  return {
    id: `memory+${next.id}`,
    async propose(req) {
      const found = await memory.recall(`${req.site} ${req.goal}`, 3).catch(() => []);
      for (const m of found) {
        const at = m.content.indexOf(HINT_MARK);
        if (at < 0 || !m.content.includes(`goal=${req.goal}`)) continue;
        try {
          const hints = JSON.parse(m.content.slice(at + HINT_MARK.length)) as Hints;
          if (JSON.stringify(hints) !== JSON.stringify(req.failed))
            return { hints, reason: `remembered: ${m.content.split(HINT_MARK)[0]?.trim()}` };
        } catch {
          // not one of ours
        }
      }
      return next.propose(req);
    },
    async learn(report) {
      if (!report.ok) return;
      await memory
        .remember(
          `site=${report.site} goal=${report.goal} repaired (${report.reason}) ${HINT_MARK}${JSON.stringify(report.hints)}`,
          { site: report.site, goal: report.goal, kind: "repair" },
        )
        .catch(() => undefined);
    },
  };
}
