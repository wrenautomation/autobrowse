import { describe, expect, it } from "vitest";
import type { Message } from "../src/auth/codes.js";
import {
  type LookOptions,
  lookForAccount,
  RESET_FORMS,
  watchForSiteMail,
} from "../src/auth/exists.js";

const form = RESET_FORMS.npm as NonNullable<(typeof RESET_FORMS)["npm"]>;

const mail = (from: string, at: Date): Message => ({ from, subject: "Reset", text: "", at });

const START = new Date("2026-09-22T00:00:00Z").getTime();

/**
 * A probe with nothing in the mailbox and a form that submits. Its clock
 * only moves when the probe sleeps, so the whole wait passes instantly.
 */
const probe = (o: Partial<LookOptions> = {}): LookOptions => {
  const clock = { at: START };
  return {
    site: "npm",
    email: "someone@example.com",
    inbox: "someone@example.com",
    form: { ...form, waitMs: 30_000 },
    ask: async () => true,
    mail: { recent: async () => [] },
    history: async () => [],
    now: () => new Date(clock.at),
    sleep: async (ms: number) => {
      clock.at += ms;
    },
    ...o,
  };
};

describe("lookForAccount", () => {
  it("answers `exists` from old mail, without touching the form", async () => {
    let asked = false;
    const look = await lookForAccount(
      probe({
        ask: async () => {
          asked = true;
          return true;
        },
        history: async () => [mail("no-reply@npmjs.com", new Date("2021-04-05T00:00:00Z"))],
      }),
    );
    expect(look.verdict).toBe("exists");
    expect(asked).toBe(false);
    expect(look.why.join(" ")).toContain("2021-04-05");
  });

  it("ignores mail from someone else in the same search", async () => {
    const look = await lookForAccount(
      probe({ history: async () => [mail("billing@npm-invoices.net", new Date())] }),
    );
    expect(look.verdict).toBe("unknown-to-the-site");
  });

  it("answers `exists` when the site writes back after being asked", async () => {
    let polls = 0;
    const look = await lookForAccount(
      probe({
        mail: {
          recent: async () => (++polls > 1 ? [mail("support@npmjs.com", new Date())] : []),
        },
      }),
    );
    expect(look.verdict).toBe("exists");
    expect(look.why.join(" ")).toContain("asked https://www.npmjs.com/forgot");
  });

  it("calls silence through the whole window `unknown-to-the-site`", async () => {
    const look = await lookForAccount(probe());
    expect(look.verdict).toBe("unknown-to-the-site");
    expect(look.why.at(-1)).toContain("30s");
  });

  it("never guesses: an unsearchable inbox or a form that will not submit is `cannot-tell`", async () => {
    expect((await lookForAccount(probe({ history: undefined }))).verdict).toBe("cannot-tell");
    expect(
      (
        await lookForAccount(
          probe({
            history: async () => {
              throw new Error("no consent");
            },
          }),
        )
      ).verdict,
    ).toBe("cannot-tell");
    expect((await lookForAccount(probe({ ask: async () => false }))).verdict).toBe("cannot-tell");
  });
});

describe("watchForSiteMail", () => {
  const clocked = () => {
    const clock = { at: START };
    return {
      now: () => new Date(clock.at),
      sleep: async (ms: number) => {
        clock.at += ms;
      },
    };
  };

  it("returns the site's first mail to a new account, ignoring everyone else's", async () => {
    let polls = 0;
    const hit = await watchForSiteMail({
      form,
      inbox: "someone@example.com",
      since: new Date(START),
      waitMs: 60_000,
      mail: {
        recent: async () =>
          ++polls < 3
            ? [mail("news@elsewhere.com", new Date())]
            : [mail("support@npmjs.com", new Date())],
      },
      ...clocked(),
    });
    expect(hit?.from).toBe("support@npmjs.com");
  });

  it("gives up with null when the site never writes", async () => {
    const hit = await watchForSiteMail({
      form,
      inbox: "someone@example.com",
      since: new Date(START),
      waitMs: 60_000,
      mail: { recent: async () => [] },
      ...clocked(),
    });
    expect(hit).toBeNull();
  });
});
