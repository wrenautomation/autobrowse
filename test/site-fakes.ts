/**
 * A site as states, for walk tests: each state has a URL, controls
 * ("button:Log in", "link:Use your passkey", "css:#confirm_yes"), text, and
 * where a click or fill leads (`on: { "click button:Log in": "home" }`).
 */
import type { FlowPage, Op } from "../src/browser/flow.js";
import { type Hints, namePattern } from "../src/browser/locate.js";
import { NeedsHuman } from "../src/browser/session.js";

export type State = { url?: string; has: string[]; text?: string; on?: Record<string, string> };

export function fakeSite(states: Record<string, State>, start: string) {
  let state = start;
  const acts: string[] = [];
  const current = () => states[state] as State;
  const url = () => current().url ?? "https://site.test/login";
  const control = (h: Hints): string | null => {
    for (const c of current().has) {
      const [role, name] = [c.slice(0, c.indexOf(":")), c.slice(c.indexOf(":") + 1)];
      const test = (want: string | undefined) => {
        if (!want) return true;
        const p = namePattern(want);
        return typeof p === "string" ? p === name : p.test(name);
      };
      if (h.css) {
        // `:has-text("…")` parts name the control; a bare selector is a "css:" control.
        const parts = [...h.css.matchAll(/has-text\("([^"]*)"\)/g)].map((m) => m[1] ?? "");
        if (parts.length ? role === "css" : role !== "css" || name !== h.css) continue;
        if (!parts.every((p) => name.toLowerCase().includes(p.toLowerCase()))) continue;
        return c;
      }
      if (h.role && h.role !== role) continue;
      if (h.text && !test(h.text)) continue;
      if (!test(h.name ?? undefined)) continue;
      if (!h.role && !h.text && !h.name) continue;
      return c;
    }
    return null;
  };
  const fp: FlowPage = {
    page: {} as FlowPage["page"],
    passkeys: {} as FlowPage["passkeys"],
    captcha: async () => ({ solved: false, kind: null, vendor: null, reason: "fake" }),
    async open() {},
    url,
    text: async () => current().text ?? "",
    html: async () => "",
    has: async (h) => control(h) !== null,
    read: async (h) => control(h)?.slice(control(h)?.indexOf(":") ?? 0) ?? "",
    wait: async () => {},
    answer: async () => {},
    waitForUrl: async (p) => (p instanceof RegExp ? p.test(url()) : p(url())),
    nextPage: async () => null,
    pages: () => [],
    switchTo() {},
    async act(op: Op, hints: Hints) {
      const c = control(hints);
      if (!c) throw new Error(`nothing matches ${JSON.stringify(hints)} in ${state}`);
      acts.push(
        `${op.kind} ${c.slice(c.indexOf(":") + 1)}${op.kind === "fill" ? `=${op.value}` : ""}`,
      );
      const next = current().on?.[`${op.kind} ${c}`];
      if (next) state = next;
    },
    async signIn() {
      return "no-login";
    },
    human(reason) {
      throw new NeedsHuman(reason);
    },
  };
  const go = (s: string) => {
    state = s;
  };
  return { fp, acts, at: () => state, go };
}
