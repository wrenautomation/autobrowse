/** A scripted FlowPage for sign-in tests: page text advances on every click; `present` answers `has`. */

import type { FlowPage, Op } from "../src/browser/flow.js";
import type { Hints } from "../src/browser/locate.js";
import { NeedsHuman } from "../src/browser/session.js";

export function fakePage(script: {
  text: string[];
  present: (h: Hints) => boolean;
  url?: string | (() => string);
  /** Called with the act count after each act, for a script that moves the URL along. */
  onAct?: (n: number) => void;
  /** What `read` answers for a locator; "" when absent. */
  read?: (h: Hints) => string;
}) {
  const acts: Array<{ op: Op; hints: Hints }> = [];
  let i = 0;
  const fp: FlowPage = {
    captcha: async () => ({ solved: false, kind: null, vendor: null, reason: "fake" }),
    page: {} as FlowPage["page"],
    async open() {},
    url: () =>
      (typeof script.url === "function" ? script.url() : script.url) ?? "https://site.test/login",
    text: async () => script.text[Math.min(i, script.text.length - 1)] ?? "",
    html: async () => "",
    has: async (h) => script.present(h),
    read: async (h) => script.read?.(h) ?? "",
    wait: async () => {},
    answer: async () => {},
    waitForUrl: async () => true,
    nextPage: async () => null,
    pages: () => [],
    switchTo() {},
    async act(op, hints) {
      acts.push({ op, hints });
      if (op.kind === "click") i++;
      script.onAct?.(acts.length);
    },
    async signIn() {
      return "no-login";
    },
    human(reason) {
      throw new NeedsHuman(reason);
    },
  };
  return { fp, acts };
}
