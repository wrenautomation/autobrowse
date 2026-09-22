/**
 * `autobrowse needs`: what only the person can give, each row with its
 * check and its command. `needs <id>` runs the ingestion when there is one
 * (a credential from the clipboard, a consent, a setup step); `needs done
 * <id>` clears a decision. Names only; no value is ever printed.
 */
import type { Command } from "commander";
import type { CredentialStore } from "credkeep";
import { ingest, parseCredentialLines, takeClipboard } from "../auth/ingest.js";
import type { SiteFacade } from "../sites/facade.js";
import {
  allNeeds,
  type DoneStore,
  formatNeeds,
  type NeedRow,
  type NeedsContext,
  resolveNeeds,
} from "./needs.js";

export interface NeedsCliDeps {
  context: () => Promise<NeedsContext>;
  done: DoneStore;
  /** Where a credential row is stored (armed is fine: it only writes). */
  credentials: () => CredentialStore;
  sites: () => SiteFacade | null;
}

async function rows(d: NeedsCliDeps): Promise<NeedRow[]> {
  return resolveNeeds(allNeeds(await d.context()), d.done.read());
}

/** `autobrowse site setup <site> <step> [--account <a>]` → its parts, or null for any other command. */
export function setupArgs(
  how: string,
): { site: string; step: string; account: string | null } | null {
  const m = /^autobrowse site setup (\S+) (\S+)(?: --account (\S+))?$/.exec(how);
  return m ? { site: m[1] as string, step: m[2] as string, account: m[3] ?? null } : null;
}

export function registerNeedsCommands(program: Command, deps: () => NeedsCliDeps): void {
  const needs = program
    .command("needs")
    .description(
      "What only you can give (logins, keys, consents, the phone link, money, decisions), each with its check and its command",
    );
  needs
    .command("list", { isDefault: true })
    .description("Open rows; --all shows what is in hand too")
    .option("--all", "in-hand rows too")
    .action(async (o: { all?: boolean }) => {
      console.log(formatNeeds(await rows(deps()), o));
    });
  needs
    .command("do <id>")
    .description(
      "Run the row's ingestion: a credential from the clipboard (`email password [authenticator key]`), a consent, a setup step; anything else is printed",
    )
    .action(async (id: string) => {
      const d = deps();
      const row = (await rows(d)).find((r) => r.id === id);
      if (!row) throw new Error(`no need ${id}: autobrowse needs`);
      if (row.done) {
        console.log(`${id} is already in hand`);
        return;
      }
      const first = row.how[0] ?? "";
      const paste = /^autobrowse creds paste (\S+)$/.exec(first);
      const setup = setupArgs(first);
      if (paste) {
        const site = paste[1] as string;
        const lines = parseCredentialLines(takeClipboard(), site);
        if (lines.length !== 1) throw new Error("the clipboard must hold exactly one line");
        console.log(`stored: ${(await ingest(d.credentials(), lines)).join(", ")}`);
      } else if (setup) {
        const sites = d.sites();
        if (!sites) throw new Error("no site apis here");
        const { made } = await sites.setup(setup.site, setup.step, setup.account);
        console.log(`kept ${made.join(", ")}`);
      } else {
        console.log(`${row.what}\n${row.how.map((h) => `  $ ${h}`).join("\n")}`);
        return;
      }
      const after = (await rows(d)).find((r) => r.id === id);
      console.log(
        after?.done ? `${id}: in hand` : `${id}: still open (check again: autobrowse needs)`,
      );
    });
  needs
    .command("done <id>")
    .description("Say a decision or a by-hand step is done (with --note, what you chose)")
    .option("--note <text>")
    .action(async (id: string, o: { note?: string }) => {
      const d = deps();
      const row = (await rows(d)).find((r) => r.id === id);
      if (!row) throw new Error(`no need ${id}: autobrowse needs`);
      d.done.mark(id, o.note);
      console.log(`${id}: done${o.note ? ` (${o.note})` : ""}`);
    });
  needs
    .command("undo <id>")
    .description("Take a `done` back")
    .action(async (id: string) => {
      deps().done.clear(id);
      console.log(`${id}: open again`);
    });
}
