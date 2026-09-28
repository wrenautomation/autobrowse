/**
 * When a locator no longer matches, a repairer looks at the page and
 * proposes another set of hints for the same goal. The proposal is data
 * (hints), never code and never an action: the flow re-applies it through
 * the same `locate` and does the same op. When the page changed shape (a
 * new "Continue" screen, a dialog in the way), the proposal is a detour: a
 * click to make first, on the live page, then the repairer looks again. The
 * run carries on from where it is, so every op runs once however many
 * broke. An irreversible op is never repaired; it goes to a person. Every
 * repair is reported so the flow's source can be fixed for good.
 */
import type { Page } from "playwright";
import { z } from "zod";
import { completeJson, type Llm } from "../llm/types.js";
import type { Memory } from "../memory/types.js";
import type { Hints } from "./locate.js";
import type { ScreenReader } from "./screens.js";

export interface RepairRequest {
  site: string;
  /** What the step is trying to do, in words: "click Purchase". */
  goal: string;
  failed: Hints;
  url: string;
  /** Interactive elements on the page, one per line, already truncated. */
  snapshot: string;
  /** Detour clicks already made for this goal: never propose one twice. */
  detours?: Hints[];
}

export interface RepairProposal {
  hints: Hints;
  reason: string;
  /** The hints name a click that must come first (a screen or dialog in the way), not the goal's control. */
  detour?: boolean;
}

export interface Repairer {
  readonly id: string;
  propose(req: RepairRequest): Promise<RepairProposal | null>;
}

export interface RepairReport extends RepairProposal {
  /** Clicks made on the way, in order, before the goal's control. */
  detours?: Hints[];
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
  detour: z.boolean().optional(),
  /** The model may say the goal cannot be met on this page. */
  giveUp: z.boolean().optional(),
});

const SYSTEM = `You repair a broken browser automation step. You get the goal, the locator hints that no longer match, and a list of the interactive elements on the page now. Pick the one element that serves the goal and describe it with hints: testId, role + name, name (label), placeholder, text, or id. Prefer stable, visible labels. If the goal's control is not on the page because something is in the way (a new intermediate screen, a dialog, a banner), name the one click that gets past it (Continue, Next, Not now, Close, Accept) and set detour true; never a detour that buys, pays, sends, submits, deletes or confirms. If nothing on the page serves the goal, set giveUp true.`;

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
          ...(req.detours?.length ? [`Detours already made: ${JSON.stringify(req.detours)}`] : []),
          "Elements:",
          req.snapshot,
          'Reply: {"hints": {...}, "reason": "...", "detour": false, "giveUp": false}',
        ].join("\n"),
        maxTokens: 400,
      });
      if (value.giveUp) return null;
      const hints: Hints = {};
      for (const [k, v] of Object.entries(value.hints))
        if (v) (hints as Record<string, string>)[k] = v;
      return { hints, reason: value.reason, ...(value.detour ? { detour: true } : {}) };
    },
  };
}

const readingSchema = z.object({
  screen: z.string().nullable().optional(),
  click: proposalSchema.shape.hints.nullable().optional(),
  reason: z.string(),
});

const READ_SYSTEM = `A browser automation walks a site's screens toward a goal. It is on a page none of its screens recognized. You get the goal, the screens it knows (name: what each looks like), the URL and the page's interactive elements. If the page is one of the known screens (a variant, a redesign), reply with its exact name in "screen". If not, and something is in the way of the goal (an intermediate screen, a dialog, a banner), name the one click that gets past it in "click" as hints (role + name, text, testId, placeholder or id); never a click that buys, pays, sends, submits, deletes or confirms. If neither, reply with neither. You never act: you only pick.`;

/** A model that names an unknown page from a walk's own screens, or one click past it (`browser/screens`). */
export function llmScreenReader(llm: Llm): ScreenReader {
  return {
    id: `llm:${llm.id}`,
    async read(req) {
      const { value } = await completeJson(llm, readingSchema, {
        system: READ_SYSTEM,
        prompt: [
          `Goal: ${req.goal}`,
          "Known screens:",
          ...req.known.map((s) => `- ${s.name}: ${s.looks}`),
          `URL: ${req.url}`,
          "Elements:",
          req.snapshot,
          'Reply: {"screen": "<name>" | null, "click": {...} | null, "reason": "..."}',
        ].join("\n"),
        maxTokens: 300,
      });
      const click: Hints = {};
      for (const [k, v] of Object.entries(value.click ?? {}))
        if (v) (click as Record<string, string>)[k] = v;
      return {
        ...(value.screen ? { screen: value.screen } : {}),
        ...(Object.keys(click).length ? { click } : {}),
        reason: value.reason,
      };
    },
  };
}

/** A detour that commits something is a person's, never the repairer's. */
export const COMMITTING =
  /\b(buy|pay|purchase|order|checkout|send|submit|delete|remove|confirm|publish|post)\b/i;

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
      // A detour path lives in the fixes file, whole; memory keeps plain hint swaps.
      if (!report.ok || report.detours?.length) return;
      await memory
        .remember(
          `site=${report.site} goal=${report.goal} repaired (${report.reason}) ${HINT_MARK}${JSON.stringify(report.hints)}`,
          { site: report.site, goal: report.goal, kind: "repair" },
        )
        .catch(() => undefined);
    },
  };
}
