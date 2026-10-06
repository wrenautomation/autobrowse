/**
 * linkedin@wren's profile basics: name, headline, city, About, Wren's websites, photo.
 * The member account William uses as Wren's founder (william@wrenautomation.com), never his
 * personal one. Mapped read-only 2026-10-06 (new UI, classes obfuscated, so roles and labels):
 * - /in/me/ redirects to /in/<vanity>/. Each part is an edit form at a URL under it, opened
 *   as a native <dialog> with "Save" and "Dismiss".
 * - edit/intro/: First name, Last name and Headline have no accessible name; each follows a
 *   paragraph with its label. Headline is a contenteditable. "City" is a typeahead.
 * - edit/forms/summary/new/: textbox "About".
 * - edit/forms/contact-info/new/: "Add website" adds a "Website URL" textbox and a
 *   "Website type" select. LinkedIn keeps three.
 * - details/experience/: one link per position, named "<title> <company> <Mon YYYY> - ...".
 * Each part reads its form first and saves only what differs, then reads it back. The
 * position is read, never edited: the form's "Notify network" posts to his network.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { imageProblem } from "../image.js";
import { profilePhotoFlow, RULE } from "../linkedin-profile-photo/index.js";

const WEBSITE_TYPES = ["Blog", "Company", "Other", "Personal", "Portfolio", "RSS Feed"] as const;

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  account: z.string().default("linkedin@wren"),
  // "Will": DMs show the first name.
  firstName: z.string().min(1).default("Will"),
  lastName: z.string().min(1).default("Jin"),
  headline: z
    .string()
    .max(220)
    .default("Founder, Wren Automation | Lead gen and hiring outreach for recruiting firms"),
  city: z.string().min(1).default("Toronto"),
  // Required by the intro form, never shown on the profile; set only while empty.
  industry: z.string().min(1).default("Business Consulting and Services"),
  about: z
    .string()
    .max(2600)
    .default(
      "I run Wren Automation in Toronto. I build lead gen and hiring outreach systems for recruiting firms and agencies, so their teams book more meetings without adding reps. If you run a recruiting firm, I'd like to hear what slows your team down.",
    ),
  // Wren's only, never his personal accounts. The LinkedIn Page shows through the position.
  websites: z
    .array(z.object({ url: z.url(), type: z.enum(WEBSITE_TYPES) }))
    .max(3)
    .default([
      { url: "https://wrenautomation.com", type: "Company" },
      { url: "https://www.youtube.com/channel/UCJvP02ENWoDeOZxec-hoz9Q", type: "Other" },
      { url: "https://x.com/wren_automation", type: "Other" },
    ]),
  /** The position that must show, read only: "<title> <company> ... <year>". */
  position: z
    .object({ title: z.string(), company: z.string(), since: z.number().int() })
    .default({ title: "Founder", company: "Wren Automation", since: 2026 }),
  /** Empty = leave the photo. */
  photoFile: z.string().default("assets/people/william-headshot-square.png"),
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

/** Per part, a hash of the values it saved and read back: a rerun skips it. */
export type Memo = Partial<Record<"intro" | "about" | "websites" | "photo", string>>;
type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export interface Profile {
  firstName: string;
  lastName: string;
  headline: string;
  city: string;
  about: string;
  websites: string[];
  /** Every position link's name. */
  positions: string[];
}

export type BasicsInput =
  | { part: "read" }
  | {
      part: "intro";
      firstName: string;
      lastName: string;
      headline: string;
      city: string;
      industry: string;
    }
  | { part: "about"; about: string }
  | { part: "websites"; websites: Plan["websites"] };

export interface BasicsOutput {
  profile: Profile;
  changed: boolean;
}

const ME = "https://www.linkedin.com/in/me/";
const WALL = /linkedin\.com\/(authwall|login|uas\/|checkpoint)/;
// Native <dialog>: no role attribute, so `dialog >>`; names exact.
const IN_DIALOG = (role: string, name: string): Hints => ({
  css: `dialog >> role=${role}[name="${name}"s]`,
});
const SAVE = IN_DIALOG("button", "Save");
/** A nameless field after the paragraph that labels it. */
const AFTER = (label: string): Hints => ({
  css: `xpath=//dialog//p[normalize-space()="${label}"]/following::*[self::input or self::textarea or @contenteditable="true"][1]`,
});
const FIRST = AFTER("First name");
const LAST = AFTER("Last name");
// Rich-text: the editor's role=textbox, never a hidden contenteditable beside it.
const HEADLINE: Hints = {
  css: `xpath=//dialog//p[normalize-space()="Headline"]/following::*[@role="textbox"][1]`,
};
const CITY = IN_DIALOG("textbox", "City");
const INDUSTRY = IN_DIALOG("textbox", "Industry");
const ABOUT = IN_DIALOG("textbox", "About");
const URLS = 'dialog >> role=textbox[name="Website URL"s]';
const TYPES = 'dialog >> role=combobox[name="Website type"s]';
const ADD_WEBSITE = IN_DIALOG("button", "Add website");
// A share-your-update prompt after a save: the way out, never its post button.
const DECLINE: Hints[] = [
  IN_DIALOG("button", "No thanks"),
  IN_DIALOG("button", "Skip"),
  IN_DIALOG("button", "Not now"),
];

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
/** A URL as LinkedIn may echo it back: no scheme, no www, no trailing slash. */
export const bareUrl = (u: string) =>
  u
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");

/** The profile's base URL, /in/<vanity>/, signed in: one sign-in try, then a person. */
async function base(fp: FlowPage): Promise<string> {
  await fp.open(ME);
  if (WALL.test(fp.url()) || (await fp.waitForUrl(WALL, 4_000))) {
    if ((await fp.signIn()) !== "signed-in")
      fp.human("LinkedIn is signed out and the one sign-in try failed");
    await fp.open(ME);
  }
  if (!(await fp.waitForUrl(/\/in\/(?!me\/)[^/]+\//, 20_000)))
    fp.human(`/in/me/ never reached a profile: ${fp.url()}`);
  return fp
    .url()
    .replace(/[?#].*$/, "")
    .replace(/\/?$/, "/");
}

async function form(fp: FlowPage, url: string): Promise<void> {
  await fp.open(url);
  if (!(await fp.has(SAVE, 20_000))) fp.human(`no edit form with Save at ${url}`);
}

/** A field's text: an input's value or a contenteditable's text. */
async function fieldText(fp: FlowPage, h: Hints): Promise<string> {
  const el = fp.page.locator(h.css as string).first();
  return norm(
    await el.evaluate((e) => {
      const f = e as unknown as { value?: string; innerText: string };
      return f.value ?? f.innerText;
    }),
  );
}

async function urlsIn(fp: FlowPage): Promise<string[]> {
  const boxes = fp.page.locator(URLS);
  const out: string[] = [];
  for (let i = 0; i < (await boxes.count()); i++) {
    const v = norm(await boxes.nth(i).inputValue());
    if (v) out.push(v);
  }
  return out;
}

async function readAll(fp: FlowPage, at: string): Promise<Profile> {
  await form(fp, `${at}edit/intro/`);
  const intro = {
    firstName: await fieldText(fp, FIRST),
    lastName: await fieldText(fp, LAST),
    headline: await fieldText(fp, HEADLINE),
    city: await fieldText(fp, CITY),
  };
  await form(fp, `${at}edit/forms/summary/new/`);
  const about = await fieldText(fp, ABOUT);
  await form(fp, `${at}edit/forms/contact-info/new/`);
  const websites = await urlsIn(fp);
  await fp.open(`${at}details/experience/`);
  await fp.wait(5_000);
  const positions = (
    await fp.page
      .locator("main")
      .getByRole("link")
      .evaluateAll((els) => els.map((e) => (e as unknown as { innerText: string }).innerText))
  )
    .map(norm)
    .filter((n) => /\b(19|20)\d\d\b/.test(n));
  return { ...intro, about, websites, positions };
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A typeahead: type, then the first suggestion that starts with the value. */
async function pick(fp: FlowPage, h: Hints, value: string, what: string): Promise<void> {
  await fp.act({ kind: "fill", value }, h, { goal: `type the ${what}` });
  await fp.act(
    { kind: "click" },
    { role: "option", name: `/^${literal(value)}/i` },
    { goal: `pick the ${what}` },
  );
}

/** LinkedIn's rich-text editor refuses fill: click in, select all, type over, as a person does. */
async function typeOver(fp: FlowPage, h: Hints, value: string, what: string): Promise<void> {
  await fp.act({ kind: "click" }, h, { goal: `click into the ${what}` });
  await fp.act({ kind: "press", key: "ControlOrMeta+A" }, h, { goal: `select the ${what}` });
  await fp.page.keyboard.insertText(value);
}

/** Save; a form still open after it was refused, and says why in its own words. */
async function save(fp: FlowPage, goal: string): Promise<void> {
  await fp.act({ kind: "click" }, SAVE, { goal, irreversible: true });
  await fp.wait(4_000);
  for (const h of DECLINE)
    if (await fp.has(h)) await fp.act({ kind: "click" }, h, { goal: "skip sharing the update" });
  if (await fp.has(SAVE)) {
    const text = await fp.page
      .locator("dialog")
      .first()
      .innerText()
      .catch(() => "");
    const why = text.split("\n").filter((l) => /required|invalid|must|too long|please/i.test(l));
    fp.human(`LinkedIn refused to ${goal}: ${why.join("; ") || "the form stayed open"}`);
  }
}

export const profileBasicsFlow = defineFlow<BasicsInput, BasicsOutput>({
  site: "linkedin",
  name: "profile-basics",
  async run(fp, input) {
    const at = await base(fp);
    if (input.part === "read") return { profile: await readAll(fp, at), changed: false };

    if (input.part === "intro") {
      await form(fp, `${at}edit/intro/`);
      let changed = false;
      for (const [h, want, goal] of [
        [FIRST, input.firstName, "first name"],
        [LAST, input.lastName, "last name"],
      ] as const) {
        if ((await fieldText(fp, h)) === norm(want)) continue;
        await fp.act({ kind: "fill", value: want }, h, { goal: `set the ${goal}` });
        changed = true;
      }
      if ((await fieldText(fp, HEADLINE)) !== norm(input.headline)) {
        await typeOver(fp, HEADLINE, input.headline, "headline");
        changed = true;
      }
      if (!(await fieldText(fp, CITY)).toLowerCase().startsWith(input.city.toLowerCase())) {
        await pick(fp, CITY, input.city, "city");
        changed = true;
      }
      if (changed && !(await fieldText(fp, INDUSTRY)))
        await pick(fp, INDUSTRY, input.industry, "industry");
      if (changed) await save(fp, "save the intro");
    } else if (input.part === "about") {
      await form(fp, `${at}edit/forms/summary/new/`);
      const changed = (await fieldText(fp, ABOUT)) !== norm(input.about);
      if (changed) {
        await typeOver(fp, ABOUT, input.about, "About");
        await save(fp, "save About");
      }
    } else {
      await form(fp, `${at}edit/forms/contact-info/new/`);
      const have = new Set((await urlsIn(fp)).map(bareUrl));
      const missing = input.websites.filter((w) => !have.has(bareUrl(w.url)));
      for (const w of missing) {
        if (!(await fp.has(ADD_WEBSITE)))
          fp.human(`LinkedIn holds no more websites; ${w.url} is not on the profile`);
        await fp.act({ kind: "click" }, ADD_WEBSITE, { goal: "add a website" });
        const n = (await fp.page.locator(URLS).count()) - 1;
        await fp.act(
          { kind: "fill", value: w.url },
          { css: `${URLS} >> nth=${n}` },
          {
            goal: `type ${w.url}`,
          },
        );
        await fp.act(
          { kind: "select", value: w.type },
          { css: `${TYPES} >> nth=${n}` },
          {
            goal: `mark it ${w.type}`,
          },
        );
      }
      if (missing.length) await save(fp, "save the websites");
    }

    // A saved name can move the profile URL: find it again.
    const profile = await readAll(fp, await base(fp));
    const off =
      input.part === "intro"
        ? profile.firstName !== norm(input.firstName) ||
          profile.lastName !== norm(input.lastName) ||
          profile.headline !== norm(input.headline) ||
          !profile.city.toLowerCase().startsWith(input.city.toLowerCase())
        : input.part === "about"
          ? profile.about !== norm(input.about)
          : input.websites.some((w) => !profile.websites.map(bareUrl).includes(bareUrl(w.url)));
    if (off) fp.human(`LinkedIn did not keep the ${input.part} after Save`);
    return { profile, changed: true };
  },
});

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const on = (plan: Plan) => ({ ...profileBasicsFlow, site: plan.account });

const check: Step<"check"> = {
  name: "check",
  async run({ fx, deps, plan }) {
    if (plan.photoFile) {
      const problem = imageProblem(plan.photoFile, RULE);
      if (problem) throw new Error(problem);
    }
    const { profile } = await fx.run(`browser read ${plan.account}'s profile`, () =>
      deps.browser.run(on(plan), { part: "read" }),
    );
    const p = plan.position;
    const has = profile.positions.some(
      (n) => n.startsWith(`${p.title} ${p.company} `) && n.includes(String(p.since)),
    );
    if (!has)
      throw new Error(
        `no "${p.title} at ${p.company}" since ${p.since} on ${plan.account}: add it by hand (its form notifies his network)`,
      );
    return done(
      `${profile.firstName} ${profile.lastName}, "${profile.headline}", ${profile.city}; ${profile.websites.length} website(s); position shows`,
    );
  },
};

/** One saved part: skipped when the memo holds these values, gated, then saved and read back. */
function part<S extends "intro" | "about" | "websites">(
  name: S,
  input: (plan: Plan) => BasicsInput,
  ask: (plan: Plan) => string,
): Step<S> {
  return {
    name,
    irreversible: true,
    async run({ fx, deps, plan, memo, gate }) {
      const want = input(plan);
      const mark = hash(want);
      if (memo[name] === mark) return skipped("already set");
      const answer = gate("send", ask(plan));
      if (!answer.approved) return rejected(answer.note ?? "not changed");
      const { changed } = await fx.run(`browser set the ${name}`, () =>
        deps.browser.run(on(plan), want),
      );
      memo[name] = mark;
      return done(changed ? "saved, read back" : "already showed these values");
    },
  };
}

const intro = part(
  "intro",
  (p) => ({
    part: "intro",
    firstName: p.firstName,
    lastName: p.lastName,
    headline: p.headline,
    city: p.city,
    industry: p.industry,
  }),
  (p) => `Set ${p.account}'s name to "${p.firstName} ${p.lastName}", headline "${p.headline}"?`,
);
const about = part(
  "about",
  (p) => ({ part: "about", about: p.about }),
  (p) => `Set ${p.account}'s About to "${p.about.slice(0, 80)}..."?`,
);
const websites = part(
  "websites",
  (p) => ({ part: "websites", websites: p.websites }),
  (p) => `Add ${p.websites.map((w) => w.url).join(", ")} to ${p.account}'s contact info?`,
);

// The photo flow, signed in as the plan's account in its own profile (not his Google one).
const { profile: _google, ...photoFlow } = profilePhotoFlow;
const photo: Step<"photo"> = {
  name: "photo",
  irreversible: true,
  async run({ fx, deps, plan, memo, gate }) {
    if (!plan.photoFile) return skipped("no photo in the plan");
    const mark = createHash("sha256").update(readFileSync(plan.photoFile)).digest("hex");
    if (memo.photo === mark) return skipped("already set");
    const answer = gate("send", `Set ${plan.account}'s photo to ${plan.photoFile}?`);
    if (!answer.approved) return rejected(answer.note ?? "not changed");
    await fx.run("browser set the profile photo", () =>
      deps.browser.run({ ...photoFlow, site: plan.account }, { file: plan.photoFile }),
    );
    memo.photo = mark;
    return done("photo saved, read back");
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "linkedin-profile-basics",
  description:
    "Set linkedin@wren's name, headline, city, About, Wren's websites and photo: each form read first, saved only where it differs, read back; the position is checked, never edited.",
  plan: planSchema,
  steps: [check, intro, about, websites, photo],
  emptyMemo: () => ({}),
});
