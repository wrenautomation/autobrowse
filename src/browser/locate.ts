/**
 * From locator hints to a Playwright locator, one priority order used in
 * two places: at run time (`applyLocator`) and by the compiler, which
 * renders the same plan as source. Test ids first, then role + accessible
 * name, then label, placeholder, text, id. Hints are what the recorder
 * captured; a redesign that keeps labels keeps the flow working. A `css`
 * hint wins outright: it is the explicit last resort. `nth` picks among
 * matches (a repeated row of controls).
 */
import type { Locator, Page } from "playwright";
import type { LocatorHints } from "../recorder/types.js";

/** Any subset of what the recorder captures; null and missing mean the same. */
export type Hints = { [K in keyof LocatorHints]?: LocatorHints[K] | null | undefined };

export type LocatorPlan =
  | { by: "css"; value: string }
  | { by: "testId"; value: string }
  | { by: "role"; role: string; name: string | null }
  | { by: "label"; value: string }
  | { by: "placeholder"; value: string }
  | { by: "text"; value: string }
  | { by: "id"; value: string };

const FIELD_TAGS = new Set(["input", "textarea", "select"]);

export function planLocator(h: Hints): LocatorPlan | null {
  if (h.css) return { by: "css", value: h.css };
  if (h.testId) return { by: "testId", value: h.testId };
  if (h.role && h.name) return { by: "role", role: h.role, name: h.name };
  if (h.name && h.tag && FIELD_TAGS.has(h.tag)) return { by: "label", value: h.name };
  if (h.placeholder) return { by: "placeholder", value: h.placeholder };
  if (h.role && !h.name && h.tag && FIELD_TAGS.has(h.tag) && h.id) return { by: "id", value: h.id };
  if (h.text) return { by: "text", value: h.text };
  if (h.role) return { by: "role", role: h.role, name: null };
  if (h.id) return { by: "id", value: h.id };
  return null;
}

/** In generated code: a `/pattern/flags` name is a regex literal, anything else a string. */
function qName(name: string): string {
  const p = namePattern(name);
  return typeof p === "string" ? JSON.stringify(p) : p.toString();
}
function exact(name: string): string {
  return typeof namePattern(name) === "string" ? ", { exact: true }" : "";
}

/** A name written `/pattern/flags` matches loosely; anything else is exact. */
export function namePattern(name: string): string | RegExp {
  const m = name.match(/^\/(.+)\/([a-z]*)$/s);
  return m ? new RegExp(m[1] as string, m[2]) : name;
}

export function applyLocator(page: Page, plan: LocatorPlan): Locator {
  switch (plan.by) {
    case "css":
      return page.locator(plan.value);
    case "testId":
      return page.getByTestId(plan.value);
    case "role": {
      // Role strings come from the DOM; Playwright's union is narrower than what a page can carry.
      const role = plan.role as Parameters<Page["getByRole"]>[0];
      if (!plan.name) return page.getByRole(role);
      const name = namePattern(plan.name);
      return typeof name === "string"
        ? page.getByRole(role, { name, exact: true })
        : page.getByRole(role, { name });
    }
    case "label": {
      const name = namePattern(plan.value);
      return typeof name === "string"
        ? page.getByLabel(name, { exact: true })
        : page.getByLabel(name);
    }
    case "placeholder": {
      const name = namePattern(plan.value);
      return typeof name === "string"
        ? page.getByPlaceholder(name, { exact: true })
        : page.getByPlaceholder(name);
    }
    case "text": {
      const name = namePattern(plan.value);
      return typeof name === "string"
        ? page.getByText(name, { exact: true })
        : page.getByText(name);
    }
    case "id":
      return page.locator(`#${CSS.escape(plan.value)}`);
  }
}

/** Every match, in page order; for forms that repeat a row of controls. */
export function locateAll(page: Page, hints: Hints): Locator {
  const plan = planLocator(hints);
  if (!plan) throw new Error(`no usable locator hints: ${JSON.stringify(hints)}`);
  return applyLocator(page, plan);
}

/** The one match a flow acts on: `nth` when the hints say so, else the first. */
/** What a person reads off the element: an input's value, anything else's text. */
export async function textOf(loc: Locator, timeout = 10_000): Promise<string> {
  const first = loc.first();
  const tag = await first.evaluate((el) => el.tagName.toLowerCase(), undefined, { timeout });
  const text =
    tag === "input" || tag === "textarea"
      ? await first.inputValue({ timeout })
      : await first.innerText({ timeout });
  return text.trim();
}

export function locate(page: Page, hints: Hints): Locator {
  return locateAll(page, hints).nth(hints.nth ?? 0);
}

/** The same plan as source, for generated flows. */
export function renderLocator(plan: LocatorPlan, page = "page"): string {
  const q = (s: string) => JSON.stringify(s);
  switch (plan.by) {
    case "css":
      return `${page}.locator(${q(plan.value)})`;
    case "testId":
      return `${page}.getByTestId(${q(plan.value)})`;
    case "role":
      return plan.name
        ? `${page}.getByRole(${q(plan.role)}, { name: ${qName(plan.name)}${typeof namePattern(plan.name) === "string" ? ", exact: true" : ""} })`
        : `${page}.getByRole(${q(plan.role)})`;
    case "label":
      return `${page}.getByLabel(${qName(plan.value)}${exact(plan.value)})`;
    case "placeholder":
      return `${page}.getByPlaceholder(${qName(plan.value)}${exact(plan.value)})`;
    case "text":
      return `${page}.getByText(${qName(plan.value)}${exact(plan.value)})`;
    case "id":
      return `${page}.locator(${q(`#${plan.value}`)})`;
  }
}

/** Node has no `CSS.escape`; enough for ids the recorder saw. */
const CSS = {
  escape: (s: string) => s.replace(/([^a-zA-Z0-9_-])/g, "\\$1"),
};
