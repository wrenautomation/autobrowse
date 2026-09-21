/**
 * `autobrowse unsubscribe`: the mailing lists an inbox got onto, shown first;
 * `--yes` leaves them (one-click, mailto, then the link in the browser).
 */
import type { Command } from "commander";
import { findSubscriptions, leave, subscriptionLines } from "../chores/unsubscribe.js";
import { httpClient } from "../clients/http.js";
import type { LocalBackend } from "./backend.js";

export function registerUnsubscribe(program: Command, local: LocalBackend): void {
  program
    .command("unsubscribe")
    .description(
      "Mailing lists the inbox got onto (senders with List-Unsubscribe): list them; --yes leaves them",
    )
    .option("--days <n>", "how far back", "30")
    .option("--account <address>", "which consented Gmail (default: the site's own)")
    .option("--keep <domains>", "comma-separated sender domains never listed")
    .option("--only <senders>", "comma-separated sender addresses to leave (with --yes)")
    .option("--yes", "leave every listed sender (or --only)")
    .option("--no-browser", "never open a link; report it instead")
    .action(
      async (o: {
        days: string;
        account?: string;
        keep?: string;
        only?: string;
        yes?: boolean;
        browser: boolean;
      }) => {
        const { backend, parts } = local();
        const sites = backend.sites;
        if (!sites) throw new Error("no site apis here");
        const account = o.account ?? null;
        const mailbox = {
          call: (method: "GET" | "POST", path: string, input: Record<string, unknown>) =>
            sites.call("gmail", method, path, input, account),
        };
        const rows = await findSubscriptions(mailbox, {
          days: Number(o.days),
          keep: o.keep ? o.keep.split(",").map((d) => d.trim()) : [],
        });
        if (rows.length === 0) {
          console.log("no lists found");
          return;
        }
        for (const line of subscriptionLines(rows)) console.log(line);
        if (!o.yes) {
          console.log(
            `\n${rows.length} lists. Leave them: autobrowse unsubscribe --yes [--only a@x,b@y]`,
          );
          return;
        }
        const only = o.only ? new Set(o.only.split(",").map((s) => s.trim().toLowerCase())) : null;
        const chosen = only ? rows.filter((r) => only.has(r.sender)) : rows;
        const profile = (await mailbox.call("GET", "/gmail/v1/users/me/profile", {})) as {
          emailAddress?: string;
        };
        const deps = {
          http: httpClient(),
          ...(profile.emailAddress
            ? {
                from: profile.emailAddress,
                send: async (raw: string) => {
                  await mailbox.call("POST", "/gmail/v1/users/me/messages/send", { raw });
                },
              }
            : {}),
          ...(o.browser ? { browser: parts.browser } : {}),
        };
        for (const sub of chosen) {
          const r = await leave(sub, deps);
          console.log(
            `${r.ok ? "left   " : "still  "} ${sub.sender.padEnd(40)} ${r.how.padEnd(9)} ${r.detail}`,
          );
        }
      },
    );
}
