import { describe, expect, it } from "vitest";
import type { FlowRunner } from "../src/browser/flow.js";
import type { HttpClient } from "../src/clients/http.js";
import { runFlow } from "../src/engine/run.js";
import {
  confirmLinks,
  inboxActivityWorkflow,
  type SubscribeInput,
} from "../src/workflows/inbox-activity/index.js";
import { fakeEffects, scriptedAnswers } from "./fakes.js";

const INBOX = "will@wren-new.test";

function fakeBrowser(refuse: string[] = []) {
  const homes: string[] = [];
  const browser: FlowRunner = {
    async run<I, O>(_flow: unknown, input: I) {
      const { home } = input as SubscribeInput;
      homes.push(home);
      const refused = refuse.some((h) => home.includes(h));
      return { subscribed: !refused, note: refused ? "a bot check" : "/" } as O;
    },
  };
  return { browser, homes };
}

function fakeHttp() {
  const opened: string[] = [];
  const http = {
    async json(url: string) {
      opened.push(url);
      return { status: 200, ok: true, body: null, headers: new Headers() };
    },
  } as unknown as HttpClient;
  return { http, opened };
}

const mail = (from: string, text: string) => ({ from, subject: "", text, at: new Date() });

function run(
  browser: FlowRunner,
  http: HttpClient,
  inbox: ReturnType<typeof mail>[],
  over: Record<string, unknown> = {},
) {
  return runFlow(
    fakeEffects().fx,
    inboxActivityWorkflow,
    {
      browser,
      http,
      gmail: {
        async setSignature() {
          return "kept" as const;
        },
        async send() {},
        async recent() {
          return inbox;
        },
        async search() {
          return [];
        },
        async whole() {
          return [];
        },
      },
    },
    inboxActivityWorkflow.plan.parse({
      inbox: INBOX,
      newsletters: ["https://www.one.test", "https://two.test"],
      confirmWaitMinutes: 0,
      ...over,
    }),
    scriptedAnswers({}).answer,
  );
}

describe("inbox-activity workflow", () => {
  it("subscribes on each page and opens the confirm links its senders mail", async () => {
    const { browser, homes } = fakeBrowser();
    const { http, opened } = fakeHttp();
    const out = await run(
      browser,
      http,
      [
        mail(
          "One <one@substack.com>",
          "Welcome to one.test! Confirm: https://one.test/confirm?t=1",
        ),
        mail("Two <hello@two.test>", "Thanks. Read online https://two.test/p/hello"),
        mail("Todoist <no-reply@todoist.com>", "https://app.todoist.test/verify_email?t=2"),
        mail("Stranger <x@else.test>", "https://else.test/confirm?t=3"),
      ],
      { senders: ["todoist.com"] },
    );
    expect(out.status).toBe("done");
    expect(homes).toEqual(["https://www.one.test", "https://two.test"]);
    expect(opened).toEqual([
      "https://one.test/confirm?t=1",
      "https://app.todoist.test/verify_email?t=2",
    ]);
    expect(out.results.confirm?.detail).toBe("2 of 2 newsletters mailed; 2 confirm links opened");
  });

  it("keeps going past one refusal; fails only when none take the inbox", async () => {
    const some = await run(fakeBrowser(["two.test"]).browser, fakeHttp().http, []);
    expect(some.results.subscribe?.detail).toContain("not taken: two.test (a bot check)");
    const none = await run(fakeBrowser(["one.test", "two.test"]).browser, fakeHttp().http, []);
    expect(none.status).toBe("failed");
  });

  it("finds confirm links, not every link", () => {
    expect(
      confirmLinks(
        "Read https://x.test/p/1 then https://x.test/subscribe/confirm?t=9 or https://x.test/verify-email/abc.",
      ),
    ).toEqual(["https://x.test/subscribe/confirm?t=9", "https://x.test/verify-email/abc"]);
    expect(
      confirmLinks(
        "confirm your subscription to https://mg.test/c/aaa The Letter. Click below. https://mg.test/c/bbb Confirm subscription © 2026",
      ),
    ).toEqual(["https://mg.test/c/bbb"]);
  });
});
