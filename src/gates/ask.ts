/**
 * A yes/no over a channel the person owns: the question goes out as a
 * note, the answer is the first reply after it that parses as yes or no.
 * No reply by the deadline is a no.
 */
import type { MessageReader } from "../auth/codes.js";
import { parseCommand } from "../channels/commands.js";
import type { Approval, Approver } from "./payment.js";

export interface AskOptions {
  note(text: string): Promise<void>;
  reader: MessageReader;
  /** The inbox replies land in (the phone's number, the Linq thread, the email). */
  inbox: string;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Told what was decided, for the log. */
  onAnswer?: (ask: Approval, answer: "yes" | "no" | "none") => void;
}

export const askLine = (ask: Approval): string =>
  `autobrowse on ${ask.site} wants to ${ask.what} at ${ask.url}. Reply yes or no.`;

export function askOverChannel(opts: AskOptions): Approver {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000; // a person is not at their phone every minute
  const pollMs = opts.pollMs ?? 3_000;
  return async (ask) => {
    const since = new Date(now());
    await opts.note(askLine(ask));
    const deadline = now() + timeoutMs;
    for (;;) {
      const replies = (await opts.reader.recent(opts.inbox, since))
        .filter((m) => m.at.getTime() >= since.getTime())
        .sort((a, b) => a.at.getTime() - b.at.getTime());
      for (const m of replies) {
        const cmd = parseCommand(m.text);
        if (cmd?.kind === "approve" || cmd?.kind === "reject") {
          const answer = cmd.kind === "approve" ? "yes" : "no";
          opts.onAnswer?.(ask, answer);
          return answer === "yes";
        }
      }
      if (now() >= deadline) {
        opts.onAnswer?.(ask, "none");
        return false;
      }
      await sleep(pollMs);
    }
  };
}
