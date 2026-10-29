/**
 * Recorded 2026-10-29 on airbnb.
 * Compiled from the recording "airbnb-search". Edit freely: the outline was the
 * source until this file was written; from here on this file is.
 *
 * The showcase flow (William 10-28): no account, no money. Dates, guests and the
 * place are plan fields; the calendar pages forward to the check-in month.
 */

import { z } from "zod";
import {
  defineFlow,
  defineWorkflow,
  done,
  type FlowPage,
  type FlowRunner,
  records,
  type StepDef,
} from "../../index.js";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  where: z.string().min(1).describe("Where: the first suggestion is taken"),
  checkIn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Check-in, YYYY-MM-DD"),
  checkOut: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Check-out, YYYY-MM-DD"),
  adults: z.number().int().min(1).max(16).default(2).describe("Adults"),
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export type WwwAirbnbCaInput = Pick<Plan, "where" | "checkIn" | "checkOut" | "adults">;

/** A calendar day as Airbnb's button names it: `20, Friday, November 2026`. */
export function dayButton(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const part = (o: Intl.DateTimeFormatOptions) =>
    d.toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  return `/^${d.getUTCDate()}, ${part({ weekday: "long" })}, ${part({ month: "long" })} ${d.getUTCFullYear()}\\./`;
}

/** Up to a year of months forward until the day shows. */
async function pickDay(fp: FlowPage, iso: string): Promise<void> {
  const day = { role: "button", name: dayButton(iso) };
  for (let i = 0; i < 12 && !(await fp.has(day, 1_500)); i++)
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^Move forward/" },
      { goal: "next month" },
    );
  await fp.act({ kind: "click" }, day, { goal: `pick ${iso}` });
}

const wwwAirbnbCaFlow = defineFlow<WwwAirbnbCaInput, Record<string, unknown>>({
  site: "airbnb",
  name: "www-airbnb-ca",
  async run(fp, input) {
    await fp.open("https://www.airbnb.com/");
    const out: Record<string, unknown> = {};
    // A fresh profile gets the cookie banner first.
    if (await fp.has({ role: "button", name: "Only necessary" }, 3_000))
      await fp.act(
        { kind: "click" },
        { role: "button", name: "Only necessary" },
        { goal: "dismiss cookies" },
      );
    await fp.act({ kind: "click" }, { role: "searchbox", name: "Where" }, { goal: "click Where" }); // page.getByRole("searchbox", { name: "Where", exact: true })
    await fp.act(
      { kind: "fill", value: input.where },
      { role: "searchbox", name: "Where" },
      { goal: "fill Where" },
    ); // page.getByRole("searchbox", { name: "Where", exact: true })
    await fp.act({ kind: "click" }, { role: "option", nth: 0 }, { goal: "the first suggestion" });
    await pickDay(fp, input.checkIn);
    await pickDay(fp, input.checkOut);
    await fp.act({ kind: "click" }, { role: "button", name: "/^Who/" }, { goal: "click /^Who/" }); // page.getByRole("button", { name: /^Who/ })
    for (let i = 0; i < input.adults; i++)
      await fp.act(
        { kind: "click" },
        { role: "button", name: "Increase Adults" },
        { goal: `adult ${i + 1}` },
      );
    await fp.act({ kind: "click" }, { role: "button", name: "Search" }, { goal: "click Search" }); // page.getByRole("button", { name: "Search", exact: true })
    out.listings = await records(fp, {
      kind: "records",
      as: "listings",
      goal: "the first listings",
      fields: [
        { key: "title", says: "listing card title" },
        { key: "subtitle", says: "name line", optional: true },
        { key: "price", says: "price line", optional: true },
        { key: "rating", says: "rating text", optional: true },
        { key: "url", says: "room link" },
      ],
      key: "url",
      max: 20,
      min: 10,
      sample: [],
      code: String.raw`return Array.from(root.querySelectorAll('[data-testid="card-container"]')).map(c => { const t = (s) => (c.querySelector(s)?.textContent || '').trim(); const a = c.querySelector('a[href*="/rooms/"]'); return { title: t('[data-testid="listing-card-title"]'), subtitle: t('[data-testid="listing-card-name"]'), price: t('[data-testid="price-availability-row"]'), rating: (c.innerText.match(/\d\.\d+ \(\d+\)/) || [''])[0], url: a ? a.href.split('?')[0] : '' }; }).filter(r => r.title && r.url);`,
    });
    return out;
  },
});

const wwwAirbnbCa: Step<"www-airbnb-ca"> = {
  name: "www-airbnb-ca",
  async run({ fx, deps, plan }) {
    const out = await fx.run("browser www-airbnb-ca", () =>
      deps.browser.run(wwwAirbnbCaFlow, {
        where: plan.where,
        checkIn: plan.checkIn,
        checkOut: plan.checkOut,
        adults: plan.adults,
      }),
    );
    // TODO: prove the result through an API read where one exists.
    return done(JSON.stringify(out));
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "airbnb-search",
  description: "Recorded 2026-10-29 on airbnb",
  site: "airbnb",
  hosts: ["www.airbnb.ca"],
  plan: planSchema,
  steps: [wwwAirbnbCa],
  emptyMemo: () => ({}),
});
