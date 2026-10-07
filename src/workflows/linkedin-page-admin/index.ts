/**
 * Make a member an admin of a LinkedIn company Page, from its Manage admins
 * screen. Hand-written from read-only runs on Wren's Page (2026-10-07,
 * aria trees and the typeahead's own calls). What the screen does:
 * - `/company/<id>/admin/settings/manage-admins/` lists admins in a table:
 *   one row per admin, a link to `/in/<vanity>/`, the role as text.
 * - "Add admin" opens "Add page admin": a member search (combobox), roles as
 *   radios (Super admin, Content admin, Analyst), Save. The radios and Save
 *   stay disabled until a member is picked.
 * - Results are name + degree + headline only: many "Will Jin"s, no link.
 *   The typeahead's graphql answer (`voyagerSearchDashReusableTypeahead`)
 *   lists the same people in the same order with each one's profile URN, so
 *   the option is picked by URN, never by name.
 * - Members need not be 1st-degree connections (LinkedIn's banner, 2026-10).
 * Runs in the profile where William's LinkedIn signs in (Google): the Page's
 * super admin. dryRun goes as far as picking the member and the role, then
 * dismisses the dialog: nothing saved.
 */

import type { Response } from "playwright";
import { z } from "zod";
import {
  defineFlow,
  defineWorkflow,
  done,
  type FlowPage,
  type FlowRunner,
  type Hints,
  rejected,
  type StepDef,
  skipped,
} from "../../index.js";

export const ROLES = {
  content: "Content admin",
  super: "Super admin",
  analyst: "Analyst",
} as const;
export type Role = keyof typeof ROLES;

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  companyId: z.string().regex(/^\d+$/).default("143656154").describe("The Page's numeric id"),
  vanity: z
    .string()
    .regex(/^[A-Za-z0-9_%-]{2,100}$/)
    .default("will-jin-15b0b1434")
    .describe("The member's handle (after /in/): linkedin@wren"),
  memberId: z
    .string()
    .regex(/^ACoAA[A-Za-z0-9_-]+$/)
    .default("ACoAAG2mApcBGns9ElJU3jCZg1KjAzEhkDRamiA")
    .describe(
      "The member's profile id (urn:li:fsd_profile:<id>): what the search result is matched by",
    ),
  query: z
    .string()
    .min(2)
    .default("Will Jin Wren Automation")
    .describe("What to type in the member search: name plus headline words narrows it"),
  role: z.enum(["content", "super", "analyst"]).default("content"),
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

export interface Memo {
  /** The member's role at check, null when not an admin. */
  had?: string | null;
  /** Set once the add read back: a rerun skips it. */
  added?: string;
}

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export interface Admin {
  name: string;
  vanity: string | null;
  role: string;
}

export interface PageAdminInput {
  companyId: string;
  /** null reads the admin table only. */
  add: {
    vanity: string;
    memberId: string;
    query: string;
    role: Role;
    /** false: pick the member and the role, then dismiss (a rehearsal). */
    save: boolean;
  } | null;
}

export interface PageAdminOutput {
  admins: Admin[];
  /** "read": no add asked; "rehearsed": picked, not saved; "added": saved and read back; "same": already so. */
  outcome: "read" | "rehearsed" | "added" | "same";
  /** The picked option's text, on a rehearsal or an add. */
  picked?: string;
}

const manage = (id: string) =>
  `https://www.linkedin.com/company/${id}/admin/settings/manage-admins/`;
const WALL = /linkedin\.com\/(authwall|login|uas\/|checkpoint)/;
/** The admin table's rows by role: its name comes from a caption, its rows may not be <tr>. */
const adminRows = (fp: FlowPage) =>
  fp.page
    .getByRole("table", { name: /admin view table/i })
    .getByRole("row")
    .filter({ hasNot: fp.page.getByRole("columnheader") });
const ADD: Hints = { role: "button", name: "Add admin" };
const DIALOG = '[role=dialog]:has(h2:text-is("Add page admin"))';
const SEARCH: Hints = { css: `${DIALOG} [role=combobox]` };
const TYPEAHEAD = /voyagerSearchDashReusableTypeahead/;
const SAVE: Hints = { role: "button", name: "/^save$/i" };
/**
 * LinkedIn's refusal inside the dialog. Seen 2026-10-07 adding linkedin@wren (3rd+, out of network):
 * "This member could not be added as a page admin. Ask the member to verify their account if they
 * have not already, and then try again." The member's ID verification is a person's step.
 */
const REFUSED: Hints = { text: "/could not be added as a page admin/i" };
const DISMISS: Hints = { css: `${DIALOG} button[aria-label="Dismiss"]` };

/** A role's rank: a member who already holds a higher one needs nothing. */
const RANK: Record<string, number> = { analyst: 1, "content admin": 2, "super admin": 3 };
export const covers = (held: string | null | undefined, want: Role) =>
  Boolean(held) && (RANK[held?.toLowerCase() ?? ""] ?? 0) >= (RANK[ROLES[want].toLowerCase()] ?? 9);

/** Each typeahead element's profile id, in the order the options show. */
export function memberIds(body: unknown): (string | null)[] {
  const elements =
    (body as { data?: { data?: { searchDashReusableTypeaheadByType?: { elements?: unknown[] } } } })
      ?.data?.data?.searchDashReusableTypeaheadByType?.elements ?? [];
  return elements.map(
    (e) => /urn:li:fsd_profile:(ACoAA[A-Za-z0-9_-]+)/.exec(JSON.stringify(e))?.[1] ?? null,
  );
}

/** The admin table's rows. */
async function readAdmins(fp: FlowPage): Promise<Admin[]> {
  const rows = adminRows(fp);
  const out: Admin[] = [];
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    const cells = row.getByRole("cell");
    const href = await row
      .locator('a[href*="/in/"]')
      .first()
      .getAttribute("href", { timeout: 2_000 })
      .catch(() => null);
    const name =
      (
        await cells
          .nth(0)
          .innerText()
          .catch(() => "")
      )
        .split("\n")[0]
        ?.trim() ?? "";
    const role = (
      await cells
        .nth(1)
        .innerText()
        .catch(() => "")
    ).trim();
    out.push({ name, vanity: /\/in\/([^/?#]+)/.exec(href ?? "")?.[1] ?? null, role });
  }
  return out;
}

/** Open Manage admins, signed in, as a super admin: one sign-in try, then a person. */
async function openManage(fp: FlowPage, id: string): Promise<Admin[]> {
  await fp.open(manage(id));
  if (WALL.test(fp.url()) || (await fp.waitForUrl(WALL, 4_000))) {
    if ((await fp.signIn("linkedin")) !== "signed-in")
      fp.human("LinkedIn is signed out and the one sign-in try failed");
    await fp.open(manage(id));
    if (WALL.test(fp.url())) fp.human(`LinkedIn still walls ${fp.url()} after signing in`);
  }
  const ready = await adminRows(fp)
    .first()
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    if (!/\/admin\//.test(fp.url()))
      fp.human(`LinkedIn sent Manage admins to ${fp.url()}: this account is not an admin of ${id}`);
    fp.human(`the admin table never loaded at ${fp.url()}`);
  }
  return readAdmins(fp);
}

/** Every dialog's and toast's words: what LinkedIn says when it refuses. */
async function says(fp: FlowPage): Promise<string> {
  const texts = await fp.page
    .locator("[role=dialog], [role=alert], .artdeco-toast-item, .artdeco-inline-feedback")
    .allInnerTexts()
    .catch(() => []);
  return texts
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" | ")
    .slice(0, 800);
}

/** Search, then click the option whose profile id is the member's. Answers the option's text. */
async function pickMember(fp: FlowPage, memberId: string, query: string): Promise<string> {
  const answered = fp.page
    .waitForResponse(
      (r: Response) =>
        TYPEAHEAD.test(r.url()) && r.url().includes(`keywords:${encodeURIComponent(query)},`),
      { timeout: 20_000 },
    )
    .catch(() => null);
  // Typed key by key: the typeahead searches on input events, a fill can skip them.
  await fp.act({ kind: "click" }, SEARCH, { goal: "focus the member search" });
  await fp.page.locator(SEARCH.css as string).pressSequentially(query, { delay: 60 });
  const res = await answered;
  if (!res) fp.human(`the member search for "${query}" never answered`);
  const ids = memberIds(await res.json().catch(() => null));
  const at = ids.indexOf(memberId);
  if (at < 0) fp.human(`no result for "${query}" is profile ${memberId} (${ids.length} results)`);
  const options = fp.page.locator(`${DIALOG} [role=listbox] [role=option]`);
  await options.nth(at).waitFor({ timeout: 10_000 });
  if ((await options.count()) !== ids.length)
    fp.human(`the search shows ${await options.count()} options but answered ${ids.length}`);
  const text = (await options.nth(at).innerText()).replace(/\s+/g, " ").trim();
  await fp.act(
    { kind: "click" },
    { css: `${DIALOG} [role=listbox] [role=option]`, nth: at },
    {
      goal: `pick ${text}`,
    },
  );
  return text;
}

async function addAdmin(fp: FlowPage, id: string, add: NonNullable<PageAdminInput["add"]>) {
  await fp.act({ kind: "click" }, ADD, { goal: "open Add page admin" });
  if (!(await fp.has({ css: DIALOG }, 10_000))) fp.human("Add page admin never opened");
  const picked = await pickMember(fp, add.memberId, add.query);
  // Disabled until a member is picked; the name starts with the role, then its description.
  // The input sits under its label, which takes the click.
  const radio: Hints = {
    css: `${DIALOG} label[for^="assign-role-radio-button-"]:has-text("${ROLES[add.role]}")`,
  };
  const role = fp.page.getByRole("radio", { name: new RegExp(`^${ROLES[add.role]}\\b`) });
  for (let i = 0; i < 20 && !(await role.isEnabled().catch(() => false)); i++) await fp.wait(500);
  if (!(await role.isEnabled().catch(() => false)))
    fp.human(
      `the ${ROLES[add.role]} role stays disabled after picking ${picked}: ${await says(fp)}`,
    );
  await fp.act({ kind: "click" }, radio, { goal: `choose ${ROLES[add.role]}` });
  if (!(await role.isChecked())) fp.human(`${ROLES[add.role]} did not take`);
  if (!add.save) {
    await fp.act({ kind: "click" }, DISMISS, { goal: "dismiss without saving" });
    // A "discard changes?" confirm may follow.
    const discard: Hints = { role: "button", name: "/^discard$/i" };
    if (await fp.has(discard, 2_000))
      await fp.act({ kind: "click" }, discard, { goal: "discard the rehearsal" });
    return { picked, saved: false };
  }
  // No wait without a timeout: a locator that matches nothing waits forever (hung runs, 2026-10-07).
  const save = fp.page.locator(DIALOG).getByRole("button", { name: /^save$/i });
  const enabled = () => save.isEnabled({ timeout: 2_000 }).catch(() => false);
  for (let i = 0; i < 20 && !(await enabled()); i++) await fp.wait(500);
  if (!(await enabled())) fp.human(`Save stays disabled: ${await says(fp)}`);
  await fp.act({ kind: "click" }, SAVE, {
    goal: `make ${picked} a ${ROLES[add.role]}`,
    irreversible: true,
  });
  // The dialog closes on success; anything left on screen is LinkedIn's answer.
  for (let i = 0; i < 20 && (await fp.has({ css: DIALOG })); i++) {
    if (await fp.has(REFUSED)) break;
    await fp.wait(500);
  }
  if (await fp.has(REFUSED)) fp.human(`LinkedIn refused: ${(await fp.read(REFUSED)).trim()}`);
  if (await fp.has({ css: DIALOG })) fp.human(`LinkedIn kept the dialog open: ${await says(fp)}`);
  const after = await says(fp);
  if (/verif|identity|government|not eligible|can.t|cannot|unable|error|wrong/i.test(after))
    fp.human(`LinkedIn says: ${after}`);
  return { picked, saved: true, id };
}

export const pageAdminFlow = defineFlow<PageAdminInput, PageAdminOutput>({
  site: "linkedin",
  name: "page-admin",
  // William's account signs in by Google: its session lives in that profile.
  profile: "provider",
  async run(fp, { companyId: id, add }) {
    const admins = await openManage(fp, id);
    if (!add) return { admins, outcome: "read" };
    const held = admins.find((a) => a.vanity === add.vanity)?.role;
    if (covers(held, add.role)) return { admins, outcome: "same" };
    const { picked, saved } = await addAdmin(fp, id, add);
    if (!saved) return { admins, outcome: "rehearsed", picked };
    // The saved table is the truth.
    const back = await openManage(fp, id);
    const row = back.find((a) => a.vanity === add.vanity);
    if (!row)
      return fp.human(`${add.vanity} is not in the admin table after saving: ${await says(fp)}`);
    if (!covers(row.role, add.role))
      fp.human(`${add.vanity} reads "${row.role}" after saving ${ROLES[add.role]}`);
    return { admins: back, outcome: "added", picked };
  },
});

const list = (admins: Admin[]) =>
  admins.map((a) => `${a.name} (${a.vanity ?? "?"}): ${a.role}`).join("; ");

const check: Step<"check"> = {
  name: "check",
  async run({ fx, deps, plan, memo }) {
    const add = plan.dryRun
      ? {
          vanity: plan.vanity,
          memberId: plan.memberId,
          query: plan.query,
          role: plan.role,
          save: false,
        }
      : null;
    const out = await fx.run("browser read Manage admins", () =>
      deps.browser.run(pageAdminFlow, { companyId: plan.companyId, add }),
    );
    memo.had = out.admins.find((a) => a.vanity === plan.vanity)?.role ?? null;
    return done(
      `admins of ${plan.companyId}: ${list(out.admins)}` +
        (out.picked ? `; rehearsed: picked "${out.picked}" as ${ROLES[plan.role]}, not saved` : ""),
    );
  },
};

const add: Step<"add"> = {
  name: "add",
  irreversible: true,
  harmless: (plan, memo) => covers(memo.had, plan.role) || memo.added === plan.vanity,
  async run({ fx, deps, plan, memo, gate }) {
    if (covers(memo.had, plan.role)) return skipped(`${plan.vanity} is already ${memo.had}`);
    if (memo.added === plan.vanity) return skipped("added by this run");
    const answer = gate(
      "send",
      `Make ${plan.vanity} (${plan.memberId}) a ${ROLES[plan.role]} of LinkedIn Page ${plan.companyId}?`,
    );
    if (!answer.approved) return rejected(answer.note ?? "not added");
    const out = await fx.run(`browser add ${plan.vanity}`, () =>
      deps.browser.run(pageAdminFlow, {
        companyId: plan.companyId,
        add: {
          vanity: plan.vanity,
          memberId: plan.memberId,
          query: plan.query,
          role: plan.role,
          save: true,
        },
      }),
    );
    memo.added = plan.vanity;
    const row = out.admins.find((a) => a.vanity === plan.vanity);
    return done(
      out.outcome === "same"
        ? `already ${row?.role}`
        : `added "${out.picked}" as ${row?.role}, read back`,
    );
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "linkedin-page-admin",
  description:
    "Make a member an admin of a LinkedIn company Page (Content admin by default): the member picked by profile id, not name, then read back from the admin table. dryRun rehearses the pick and dismisses.",
  plan: planSchema,
  steps: [check, add],
  emptyMemo: () => ({}),
});
