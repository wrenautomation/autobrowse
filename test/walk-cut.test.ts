import { describe, expect, it } from "vitest";
import type { PageLook } from "../src/browser/screens.js";
import type { Action, LocatorHints } from "../src/recorder/types.js";
import type { RunRow, RunSummary } from "../src/runs/log.js";
import { buildCut, type CutFile, cutSchema, draftCut } from "../src/walks/cut.js";
import type { WalkOp, WalkSpec } from "../src/walks/spec.js";

const RUN = "20261023-135825-44fa";
const SSO = "https://sso.lms.test/ls/?SAMLRequest=once";
const HOME = "https://lms.test/d2l/home/777";
const FOLDERS_URL = "https://lms.test/d2l/lms/dropbox/user/folders_list.d2l?ou=777";
const SUBMIT_URL = "https://lms.test/d2l/lms/dropbox/user/folder_submit_files.d2l?db=42&ou=777";
const QUIZ_URL = "https://lms.test/d2l/lms/quizzing/user/quiz_summary.d2l?ou=777&qi=5501";

const look = (url: string, heading: string): PageLook => ({
  url: url.replace(/^https:\/\//, ""),
  landmarks: [`heading ${heading}`],
});
const SIGN_IN = look(SSO, "sign in");
const CODE = look("https://sso.lms.test/duo", "send a code");
const FOLDERS = look(FOLDERS_URL, "assignments");
const SUBMIT = look(SUBMIT_URL, "submit files");
const RESULTS_URL = "https://lms.test/d2l/lms/dropbox/user/results.d2l?ou=777";
const DONE = look(RESULTS_URL, "submission received");
const QUIZ = look(QUIZ_URL, "quiz one");

const H = (role: string, name: string): LocatorHints => ({
  tag: role === "button" ? "button" : "input",
  role,
  name,
  text: null,
  placeholder: null,
  id: null,
  testId: null,
  href: null,
  inputType: null,
});
const nav = (url: string): Action => ({ kind: "navigate", t: 0, url });
const click = (name: string, url: string, role = "button"): Action => ({
  kind: "click",
  t: 0,
  url,
  target: H(role, name),
});

let tick = 0;
const at = () => new Date(Date.UTC(2026, 9, 23, 12, 0, 0) + tick++ * 60_000).toISOString();
const act = (a: Action, l: PageLook | null): RunRow => ({ kind: "act", at: at(), act: a, look: l });
const mark = (name: string): RunRow => act({ kind: "cut", t: 0, url: HOME, name }, null);

const rows: RunRow[] = [
  {
    kind: "start",
    at: at(),
    run: RUN,
    site: "lms",
    driver: "console",
    goal: "do the course work",
    machine: "m",
    resumed: false,
    viewport: null,
  },
  act(nav(SSO), null), // 1
  act(
    {
      kind: "input",
      t: 0,
      url: SSO,
      target: H("textbox", "User"),
      value: "",
      redacted: false,
      secret: "lms.username",
    },
    SIGN_IN,
  ), // 2
  act(click("Sign in", SSO), SIGN_IN), // 3
  act(click("Send a passcode", "https://sso.lms.test/duo"), CODE), // 4
  mark("dropbox-submit"), // 5
  act(nav(FOLDERS_URL), null), // 6
  act(click("Assignment 3", FOLDERS_URL, "link"), FOLDERS), // 7
  act(
    { kind: "upload", t: 0, url: SUBMIT_URL, target: H("button", "Upload"), files: ["/tmp/a.pdf"] },
    SUBMIT,
  ), // 8
  act(click("Submit", SUBMIT_URL), SUBMIT), // 9
  act(click("Yes", RESULTS_URL), SUBMIT), // 10: an act's URL is the page it landed on
  mark("quiz-attempt"), // 11
  act(nav(QUIZ_URL), null), // 12
  act(click("Start Quiz!", QUIZ_URL), QUIZ), // 13
  act(click("2", QUIZ_URL, "checkbox"), QUIZ), // 14
  act(click("Submit Quiz", QUIZ_URL), QUIZ), // 15
  { kind: "end", at: at(), outcome: "achieved", summary: null, look: DONE },
];
const summary: RunSummary = {
  run: RUN,
  site: "lms",
  driver: "console",
  goal: "do the course work",
  outcome: "achieved",
  summary: null,
  startedAt: rows[0]?.at as string,
  endedAt: rows.at(-1)?.at as string,
  cmds: 0,
  acts: 15,
  tokens: 0,
  full: 0,
};
const runs = new Map([[RUN, { summary, rows }]]);
const ops = (w: WalkSpec): WalkOp[] => w.screens.flatMap((s) => s.ops);
const named = (ws: WalkSpec[], name: string) => ws.find((w) => w.name === name) as WalkSpec;

describe("cut a run into walks", () => {
  it("drafts from cut marks: the sign-in, a part per mark, query ids, the upload, the gate", () => {
    const d = draftCut("lms", RUN, rows);
    expect(d.login).toEqual({ acts: "1-4" });
    expect(d.parts).toEqual([
      {
        name: "dropbox-submit",
        acts: "dropbox-submit",
        params: { ou: "url:ou", file: "upload:8" },
        gate: 9,
      },
      {
        name: "quiz-attempt",
        acts: "quiz-attempt",
        params: { ou: "url:ou", qi: "url:qi" },
        gate: 15,
      },
    ]);
  });

  it("builds each part: params as fields, the gate, a read after, an op the run missed", () => {
    const cut: CutFile = cutSchema.parse({
      site: "lms",
      runs: [RUN],
      login: { acts: "1-4", credential: "uw" },
      parts: [
        {
          name: "dropbox-submit",
          acts: "dropbox-submit",
          params: { ou: "url:ou", file: "upload:8" },
          gate: 9,
          reads: [{ after: 10, as: "submissionId", hints: { text: "Submission ID" } }],
          insert: [
            {
              before: 8,
              op: {
                kind: "eval",
                goal: "click My Computer",
                js: "(el) => el.click()",
                irreversible: false,
              },
            },
          ],
        },
      ],
      workflows: [{ name: "submit-assignment", steps: ["login", "dropbox-submit"] }],
    });
    const out = buildCut(cut, runs, new Date("2026-10-23T12:00:00Z"));
    const walks = out.walks.map((b) => b.spec);

    const login = named(walks, "login");
    expect(login.start).toBe(HOME); // where it lands, never the one-time sign-in URL
    expect(login.irreversible).toBe(false); // "Send a passcode" sends nothing that matters
    expect(login.secrets.map((s) => s.key)).toEqual(["uw.username"]); // the cut's credential
    // Signed in: the page the run went to next, not the Duo page the last act was taken on.
    expect(login.screens.find((s) => s.goal)?.url).toBe("lms.test/d2l/home/*");

    const drop = named(walks, "dropbox-submit");
    expect(drop.start).toBe("https://lms.test/d2l/lms/dropbox/user/folders_list.d2l?ou=%7Bou%7D");
    expect(drop.fields.map((f) => f.key).sort()).toEqual(["file", "ou"]);
    expect(drop.irreversible).toBe(true);
    const kinds = ops(drop).map((o) =>
      o.kind === "click" ? `click ${o.hints.name}${o.irreversible ? "!" : ""}` : o.kind,
    );
    expect(kinds).toEqual([
      "click Assignment 3",
      "eval",
      "upload",
      "click Submit!",
      "click Yes",
      "read",
    ]);
    // Done: the page "Yes" landed on, never the next part's page.
    expect(drop.screens.find((s) => s.goal)?.url).toBe("lms.test/d2l/lms/dropbox/user/results.d2l");
    const up = ops(drop).find((o) => o.kind === "upload");
    expect(up?.kind === "upload" && up.file).toEqual({ from: "plan", field: "file" });

    const flow = out.workflows[0] as WalkSpec;
    expect(ops(flow).map((o) => o.kind)).toEqual(["open", "walk", "open", "walk"]);
    expect(flow.fields.map((f) => f.key)).toEqual(["ou"]);
    expect(flow.irreversible).toBe(true);
  });

  it("repeats acts per row: a nested walk with the clicked name as its field", () => {
    const cut = cutSchema.parse({
      site: "lms",
      runs: [RUN],
      parts: [
        {
          name: "quiz-attempt",
          acts: "12-15",
          params: { ou: "url:ou", qi: "url:qi", choice: "click:14" },
          repeat: { acts: "14", over: "answers" },
          gate: 15,
        },
      ],
    });
    const walks = buildCut(cut, runs).walks.map((b) => b.spec);
    const each = named(walks, "quiz-attempt-each");
    expect(ops(each)).toEqual([
      expect.objectContaining({
        kind: "click",
        hints: expect.objectContaining({ name: "{choice}" }),
      }),
    ]);
    const quiz = named(walks, "quiz-attempt");
    expect(quiz.start).toBe(
      "https://lms.test/d2l/lms/quizzing/user/quiz_summary.d2l?ou=%7Bou%7D&qi=%7Bqi%7D",
    );
    expect(quiz.fields.map((f) => f.key).sort()).toEqual(["answers", "ou", "qi"]);
    expect(ops(quiz).map((o) => o.kind)).toEqual(["click", "each", "click"]);
  });

  it("skips acts: the run's other repeat rows, a stray click", () => {
    const cut = cutSchema.parse({
      site: "lms",
      runs: [RUN],
      parts: [{ name: "drop", acts: "6-10", skip: [7] }],
    });
    const drop = named(
      buildCut(cut, runs).walks.map((b) => b.spec),
      "drop",
    );
    expect(ops(drop).map((o) => (o.kind === "click" ? o.hints.name : o.kind))).toEqual([
      "upload",
      "Submit",
      "Yes",
    ]);
    expect(() =>
      buildCut(
        cutSchema.parse({ ...cut, parts: [{ name: "drop", acts: "6-10", skip: [12] }] }),
        runs,
      ),
    ).toThrow(/skip 12 is not in 6-10/);
  });

  it("reads an API on a page a load opened, with no act on it", () => {
    const cut = cutSchema.parse({
      site: "lms",
      runs: [RUN],
      parts: [
        {
          name: "folders",
          acts: "6",
          params: { ou: "url:ou" },
          insert: [
            {
              after: 6,
              op: {
                kind: "eval",
                goal: "read the folders",
                js: "async () => (await fetch('/api/folders')).json()",
                irreversible: false,
                as: "folders",
              },
            },
          ],
        },
      ],
    });
    const folders = named(
      buildCut(cut, runs).walks.map((b) => b.spec),
      "folders",
    );
    expect(folders.start).toContain("ou=%7Bou%7D");
    expect(ops(folders)).toEqual([expect.objectContaining({ kind: "eval", as: "folders" })]);
  });

  it("refuses a workflow step that names no part, and an act outside its part", () => {
    expect(() =>
      cutSchema.parse({
        site: "lms",
        runs: [RUN],
        parts: [],
        workflows: [{ name: "w", steps: ["nope"] }],
      }),
    ).toThrow(/names no part/);
    const cut = cutSchema.parse({
      site: "lms",
      runs: [RUN],
      parts: [{ name: "drop", acts: "6-10", gate: 13 }],
    });
    expect(() => buildCut(cut, runs)).toThrow(/gate 13 is not in 6-10/);
  });
});
