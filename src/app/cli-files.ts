/**
 * `autobrowse files …`: one sealed store of files for forms (designs/2026-10-20-files.md).
 * A `paper` is an ID document (gated per file and host); a `doc` is anything else (a resume,
 * a transcript), its text read once here. Added from a file or from a phone by a drop link;
 * nothing here prints a file's bytes or text.
 */
import { readFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import type { Command } from "commander";
import { linkTtl, mintDrop, takeDrop } from "../auth/link.js";
import { expandHome } from "../google-auth.js";
import type { Settings } from "./config.js";
import { auditFor, filesFor, oldPapersDir } from "./services.js";

type Meta = { id?: string; side?: string; owner?: string; expires?: string; note?: string };

async function metaOf(name: string, o: Meta, filename?: string) {
  const { PAPER_IDS } = await import("../files/store.js");
  if (o.id && !(PAPER_IDS as readonly string[]).includes(o.id))
    throw new Error(`--id is one of ${PAPER_IDS.join(", ")}`);
  if (!o.id && o.side) throw new Error("--side is for a paper: give its --id too");
  if (!o.id && !o.note) throw new Error("--note: one line saying what it is, for the agent");
  return {
    name,
    kind: o.id ? ("paper" as const) : ("doc" as const),
    ...(o.id ? { id: o.id as (typeof PAPER_IDS)[number] } : {}),
    ...(o.side ? { side: o.side as "front" | "back" | "whole" } : {}),
    ...(o.note ? { note: o.note } : {}),
    ...(o.owner ? { owner: o.owner } : {}),
    ...(o.expires ? { expires: o.expires } : {}),
    ...(filename ? { filename } : {}),
  };
}

const metaOptions = (c: Command) =>
  c
    .option(
      "--id <id>",
      "an ID document (a paper: gated per file and host): drivers-licence, passport, id-card, business-registration, utility-bill, bank-statement, other",
    )
    .option("--side <side>", "a paper's side: front, back or whole (default whole)")
    .option("--note <text>", "one line for the agent: what it is (needed for a doc)")
    .option("--owner <profile>", "the profile it belongs to (default: the only one)")
    .option("--expires <date>", "when the document expires, YYYY-MM-DD");

export function registerFilesCommands(program: Command, settings: Settings): void {
  const files = program
    .command("files")
    .description(
      "Files for forms (papers: ID documents; docs: resume, transcript): sealed on this Mac, backed up to a bucket only William's AWS user reaches",
    );
  metaOptions(
    files
      .command("add <name> <file>")
      .description(
        "Store a file (JPEG, PNG, HEIC, WebP, PDF, DOCX, TXT, MD; 12 MB at most); a doc's text is read now",
      )
      .option("--remove-original", "delete <file> once it is stored"),
  ).action(async (name: string, file: string, o: Meta & { removeOriginal?: boolean }) => {
    const { describeFile, fileOf } = await import("../files/store.js");
    const data = readFileSync(file);
    const f = await fileOf(data, await metaOf(name, o, basename(file)));
    const store = await filesFor(settings);
    await store.put(f, data);
    if (o.removeOriginal) unlinkSync(file);
    console.log(
      `stored ${describeFile(f)}${store.backedUp ? "; backed up" : "; no backup (PAPERS_BUCKET unset)"}${o.removeOriginal ? "" : `; ${file} is still there`}`,
    );
  });
  metaOptions(
    files
      .command("ask <name>")
      .description(
        "A link to send it from a phone: sealed in the phone's browser, only this Mac opens it; waits for it",
      )
      .option(
        "--open",
        "no Wren sign-in on the phone: the link alone sends (for someone outside Wren)",
      )
      .option("--ttl <time>", "the link dies unsent after 10m, 24h, 7d (default 30m)"),
  ).action(async (name: string, o: Meta & { open?: boolean; ttl?: string }) => {
    if (!settings.credLinkSecret)
      throw new Error("no CRED_LINK_SECRET in the env (wren deploy/phone.md)");
    const { describeFile, fileOf, paperLabel } = await import("../files/store.js");
    const meta = await metaOf(name, o);
    const ttl = o.ttl ? linkTtl(o.ttl) : 1800;
    const label = meta.kind === "paper" ? paperLabel(meta.id, meta.side) : (meta.note ?? name);
    const drop = await mintDrop(settings.credLinkUrl, settings.credLinkSecret, label, {
      open: o.open,
      ttl,
    });
    console.log(drop.link);
    console.log(
      `waiting up to ${Math.round(ttl / 60)} min for it (Ctrl-C to stop; ask again later)`,
    );
    const until = Date.now() + ttl * 1000;
    for (;;) {
      const data = await takeDrop(settings.credLinkUrl, settings.credLinkSecret, drop);
      if (data) {
        const f = await fileOf(data, meta);
        const store = await filesFor(settings);
        await store.put(f, data);
        await auditFor(settings).record({
          at: new Date().toISOString(),
          credential: `file:${name}`,
          site: "files",
          field: "secret",
          url: `${settings.credLinkUrl}/drops`,
          by: o.open ? "files ask --open" : "files ask",
          allowed: true,
        });
        return console.log(`stored ${describeFile(f)}${store.backedUp ? "; backed up" : ""}`);
      }
      if (Date.now() > until) throw new Error("nothing came before the link died: ask again");
      await new Promise((r) => setTimeout(r, 3000));
    }
  });
  files
    .command("list")
    .description("Name, kind, type, size, note, and the sets each is in: never the bytes or text")
    .action(async () => {
      const { describeFile } = await import("../files/store.js");
      const store = await filesFor(settings);
      const [all, sets] = await Promise.all([store.list(), store.sets()]);
      const setsOf = (n: string) =>
        Object.entries(sets)
          .filter(([, ns]) => ns.includes(n))
          .map(([s]) => s);
      console.log(
        all.length
          ? all
              .map((f) => {
                const in_ = setsOf(f.name);
                return `${describeFile(f)}${in_.length ? ` [${in_.join(", ")}]` : ""}`;
              })
              .join("\n")
          : "no files (autobrowse files add)",
      );
    });
  files
    .command("remove <name>")
    .description("Drop a file here, from every set and from the backup")
    .action(async (name: string) => {
      const had = await (await filesFor(settings)).remove(name);
      console.log(had ? `removed ${name}` : `no file ${name} here; its backup is gone too`);
    });
  files
    .command("set <set> <files...>")
    .description(
      "Name a set of files (replaces it): `explore --files <set>` starts with them at the ready",
    )
    .action(async (set: string, names: string[]) => {
      await (await filesFor(settings)).setSet(set, names);
      console.log(`set ${set}: ${names.join(", ")}`);
    });
  files
    .command("sets")
    .description("Every named set and its files")
    .action(async () => {
      const sets = await (await filesFor(settings)).sets();
      const lines = Object.entries(sets).map(([s, ns]) => `${s}: ${ns.join(", ") || "(empty)"}`);
      console.log(lines.length ? lines.join("\n") : "no sets (autobrowse files set <set> <file…>)");
    });
  files
    .command("unset <set>")
    .description("Drop a named set (its files stay)")
    .action(async (set: string) => {
      await (await filesFor(settings)).setSet(set, null);
      console.log(`unset ${set}`);
    });
  files
    .command("backup")
    .description("Every file and set to the bucket again (after a backup failed)")
    .action(async () => {
      const names = await (await filesFor(settings)).backup();
      console.log(names.length ? `backed up ${names.join(", ")}` : "no files");
    });
  files
    .command("restore")
    .description("Every file and set back from the bucket (a new Mac, a lost file)")
    .action(async () => {
      const names = await (await filesFor(settings)).restore();
      console.log(names.length ? `restored ${names.join(", ")}` : "no files in the backup");
    });
  files
    .command("migrate")
    .description(
      "Once: the old `papers` dir into this store, each copy read back and compared, then the old dir moved to papers-retired (never deleted)",
    )
    .option("--from <dir>", "the old papers dir (default: papers/ beside the files dir)")
    .action(async (o: { from?: string }) => {
      const { aesGcmCipher, keychainKey } = await import("credvault");
      const { WALLET_KEYCHAIN } = await import("../auth/keep.js");
      const { migratePapers } = await import("../files/migrate.js");
      const from = o.from ? expandHome(o.from) : oldPapersDir(expandHome(settings.filesDir));
      const store = await filesFor(settings, { migrating: true });
      const r = await migratePapers({
        from,
        cipher: aesGcmCipher(keychainKey(WALLET_KEYCHAIN)),
        to: store,
      });
      if (!r.retiredTo) return console.log(`nothing to move: no ${from}`);
      console.log(
        `moved ${r.total} paper(s) (${r.copied} copied, ${r.already} already here), each read back and matched; ${from} → ${r.retiredTo}${r.unindexed ? `; ${r.unindexed} unindexed sealed file(s) kept there` : ""}`,
      );
      if (store.backedUp && r.total) {
        try {
          await store.backup();
          console.log("backed up to files/ in the bucket (the old papers/ objects stay)");
        } catch (err) {
          console.log(
            `backup failed (${(err as Error).name}): autobrowse aws-login, then autobrowse files backup`,
          );
        }
      }
    });
}
