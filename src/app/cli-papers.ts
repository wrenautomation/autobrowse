/**
 * `autobrowse papers …`: identity documents for verification forms (designs/2026-10-12-papers.md).
 * Added from a file here or from a phone by a drop link; nothing here prints an image, only
 * kind, side, type and size.
 */
import { readFileSync, unlinkSync } from "node:fs";
import type { Command } from "commander";
import { linkTtl, mintDrop, takeDrop } from "../auth/link.js";
import { describePaper, PAPER_KINDS, type Paper, paperOf } from "../money/papers.js";
import type { Settings } from "./config.js";
import { auditFor, papersFor } from "./services.js";

type Meta = { kind: string; side?: string; owner?: string; expires?: string };

function metaOf(name: string, o: Meta): Parameters<typeof paperOf>[1] {
  if (!(PAPER_KINDS as readonly string[]).includes(o.kind))
    throw new Error(`--kind is one of ${PAPER_KINDS.join(", ")}`);
  return {
    name,
    kind: o.kind as Paper["kind"],
    ...(o.side ? { side: o.side as Paper["side"] } : {}),
    ...(o.owner ? { owner: o.owner } : {}),
    ...(o.expires ? { expires: o.expires } : {}),
  };
}

const kindOptions = (c: Command) =>
  c
    .requiredOption("--kind <kind>", PAPER_KINDS.join(", "))
    .option("--side <side>", "front, back or whole (default whole)")
    .option("--owner <profile>", "the profile it belongs to (default: the only one)")
    .option("--expires <date>", "when the document expires, YYYY-MM-DD");

export function registerPapersCommands(program: Command, settings: Settings): void {
  const papers = program
    .command("papers")
    .description(
      "Identity documents for verification forms: sealed on this Mac, backed up to a bucket only William's AWS user reaches",
    );
  kindOptions(
    papers
      .command("add <name> <file>")
      .description("Store a photo or PDF (JPEG, PNG, HEIC, WebP, PDF; 12 MB at most)")
      .option("--remove-original", "delete <file> once it is stored"),
  ).action(async (name: string, file: string, o: Meta & { removeOriginal?: boolean }) => {
    const data = readFileSync(file);
    const paper = paperOf(data, metaOf(name, o));
    const store = await papersFor(settings);
    await store.put(paper, data);
    if (o.removeOriginal) unlinkSync(file);
    console.log(
      `stored ${describePaper(paper)}${store.backedUp ? "; backed up" : "; no backup (PAPERS_BUCKET unset)"}${o.removeOriginal ? "" : `; ${file} is still there`}`,
    );
  });
  kindOptions(
    papers
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
    const meta = metaOf(name, o);
    const ttl = o.ttl ? linkTtl(o.ttl) : 1800;
    const label = `${meta.kind}${meta.side && meta.side !== "whole" ? ` ${meta.side}` : ""}`;
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
        const paper = paperOf(data, meta);
        const store = await papersFor(settings);
        await store.put(paper, data);
        await auditFor(settings).record({
          at: new Date().toISOString(),
          credential: `paper:${name}`,
          site: "papers",
          field: "secret",
          url: `${settings.credLinkUrl}/drops`,
          by: o.open ? "papers ask --open" : "papers ask",
          allowed: true,
        });
        return console.log(`stored ${describePaper(paper)}${store.backedUp ? "; backed up" : ""}`);
      }
      if (Date.now() > until) throw new Error("nothing came before the link died: ask again");
      await new Promise((r) => setTimeout(r, 3000));
    }
  });
  papers
    .command("list")
    .description("Name, kind, side, type, size, expiry: never the image")
    .action(async () => {
      const all = await (await papersFor(settings)).list();
      console.log(
        all.length ? all.map(describePaper).join("\n") : "no papers (autobrowse papers add)",
      );
    });
  papers
    .command("remove <name>")
    .description("Drop a paper here and from the backup")
    .action(async (name: string) => {
      const had = await (await papersFor(settings)).remove(name);
      console.log(had ? `removed ${name}` : `no paper ${name} here; its backup is gone too`);
    });
  papers
    .command("backup")
    .description("Every paper to the bucket again (after a backup failed)")
    .action(async () => {
      const names = await (await papersFor(settings)).backup();
      console.log(names.length ? `backed up ${names.join(", ")}` : "no papers");
    });
  papers
    .command("restore")
    .description("Every paper back from the bucket (a new Mac, a lost file)")
    .action(async () => {
      const names = await (await papersFor(settings)).restore();
      console.log(names.length ? `restored ${names.join(", ")}` : "no papers in the backup");
    });
}
