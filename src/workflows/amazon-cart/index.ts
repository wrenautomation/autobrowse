/**
 * Recorded 2026-10-29 on amazon. Search a department, open the first hardcover,
 * add a quantity to the cart, read the cart's subtotal line. Never checks out.
 * Compiled from the recording "amazon-cart". Edit freely: the outline was the
 * source until this file was written; from here on this file is.
 */

import { z } from "zod";
import { defineFlow, defineWorkflow, done, type FlowRunner, type StepDef } from "../../index.js";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  searchFor: z.string().min(1).describe("the search words"),
  department: z.string().default("Books").describe("the search box's department"),
  quantity: z.number().int().min(1).max(10).default(1),
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export type WwwAmazonComInput = Pick<Plan, "searchFor" | "department" | "quantity">;

const wwwAmazonComFlow = defineFlow<WwwAmazonComInput, Record<string, string>>({
  site: "amazon",
  name: "www-amazon-com",
  async run(fp, input) {
    await fp.open("https://www.amazon.com/");
    // Some visits get the "go to your country's Amazon" modal over the search box.
    const stay = { css: "#redir-stay-at-www" };
    if (await fp.has(stay, 3_000)) await fp.act({ kind: "click" }, stay, { goal: "stay on .com" });
    const out: Record<string, string> = {};
    await fp.act(
      { kind: "select", value: input.department },
      { role: "combobox", name: "Select the department you want to search in" },
      { goal: "pick the department" },
    ); // page.getByRole("combobox", { name: "Select the department you want to search in", exact: true })
    await fp.act(
      { kind: "fill", value: input.searchFor },
      { role: "searchbox", name: "Search Amazon" },
      { goal: "fill Search Amazon" },
    ); // page.getByRole("searchbox", { name: "Search Amazon", exact: true })
    await fp.act({ kind: "click" }, { role: "button", name: "Go" }, { goal: "click Go" }); // page.getByRole("button", { name: "Go", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "link", name: "Hardcover", nth: 0 },
      { goal: "click Hardcover" },
    ); // page.getByRole("link", { name: "Hardcover", exact: true })
    out.title = await fp.read({ css: "#productTitle" }); // page.locator("#productTitle")
    await fp.act(
      { kind: "select", value: String(input.quantity) },
      { role: "combobox", name: "Quantity:" },
      { goal: "pick the quantity" },
    ); // page.getByRole("combobox", { name: "Quantity:", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Add to cart" },
      { goal: "click Add to cart" },
    ); // page.getByRole("button", { name: "Add to cart", exact: true })
    // The cart, not the add-on page Amazon may show first.
    await fp.open("https://www.amazon.com/gp/cart/view.html");
    // "Subtotal (N items): <price>"; the cart keeps earlier runs' items
    out.subtotal = await fp.read({ css: "[data-name='Subtotals']" });
    return out;
  },
});

const wwwAmazonCom: Step<"www-amazon-com"> = {
  name: "www-amazon-com",
  async run({ fx, deps, plan }) {
    const out = await fx.run("browser www-amazon-com", () =>
      deps.browser.run(wwwAmazonComFlow, plan),
    );
    // TODO: prove the result through an API read where one exists.
    return done(JSON.stringify(out));
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "amazon-cart",
  description: "Recorded 2026-10-29 on amazon",
  plan: planSchema,
  steps: [wwwAmazonCom],
  emptyMemo: () => ({}),
});
