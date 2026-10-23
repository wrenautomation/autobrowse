/**
 * The options in one region of a page (a quiz question) and the text a
 * person reads for each: what a walk's `pick` op chooses by.
 */

import type { Page } from "playwright";

/** The controls a pick chooses among, chained under the region's selector. */
export const OPTIONS = "input[type=checkbox], input[type=radio], [role=checkbox], [role=radio]";
/** An option's row when the op names none: the element that holds its text. */
export const ROWS = "tr, li, label";

export interface PickOption {
  type: "checkbox" | "radio";
  checked: boolean;
  /** Its row's text, shadow roots too, spaces squashed, lower case. */
  text: string;
}

/** Case and spaces aside: how a choice and an option's text compare. */
export const squash = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

interface Node {
  nodeType: number;
  textContent: string | null;
  childNodes: Iterable<Node>;
}
interface El extends Node {
  tagName: string;
  type?: string;
  checked?: boolean;
  shadowRoot: Node | null;
  getAttribute(name: string): string | null;
  closest(sel: string): El | null;
  querySelector(sel: string): El | null;
  parentElement: El | null;
  assignedNodes?(o: { flatten: boolean }): Node[];
}

/** Every option under `selector` (in `frame`), in page order. */
export async function optionsIn(
  page: Page,
  selector: string,
  frame: string | null | undefined,
  row: string,
  label: string | undefined,
): Promise<PickOption[]> {
  const root = frame ? page.frameLocator(frame) : page;
  const found = await root.locator(selector).evaluateAll(
    (els, [row, label]) => {
      // Text as rendered: into a shadow root, and a slot's assigned nodes, never both.
      const deep = (n: Node): string => {
        if (n.nodeType === 3) return n.textContent ?? "";
        if (n.nodeType !== 1 && n.nodeType !== 11) return "";
        const el = n as El;
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return "";
        if (el.shadowRoot) return deep(el.shadowRoot);
        const assigned = el.tagName === "SLOT" ? (el.assignedNodes?.({ flatten: true }) ?? []) : [];
        return [...(assigned.length ? assigned : el.childNodes)].map(deep).join(" ");
      };
      return (els as unknown as El[]).map((el) => {
        const r = el.closest(row as string) ?? el.parentElement;
        const t = label ? r?.querySelector(label) : r;
        const role = el.getAttribute("role");
        return {
          type: el.type === "radio" || role === "radio" ? "radio" : "checkbox",
          checked: el.checked ?? el.getAttribute("aria-checked") === "true",
          text: t ? deep(t) : "",
        };
      });
    },
    [row, label ?? ""] as const,
  );
  return found.map((o) => ({ ...o, type: o.type as PickOption["type"], text: squash(o.text) }));
}
