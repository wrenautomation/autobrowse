/**
 * `autobrowse share`: the shared library switch (designs/2026-10-24-shared-library.md).
 * On by default; `off` stops it and empties the queue.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
  NOTICE,
  queued,
  readShare,
  sendShared,
  shareOff,
  shareRoot,
  writeShare,
} from "../share/share.js";

export function registerShareCommands(program: Command): void {
  const share = program
    .command("share")
    .description(
      "Scrubbed run traces shared with Wren to make flows better (on by default): status, on, off, exclude, send",
    );
  share
    .command("status", { isDefault: true })
    .description("on or off, why, the exclude list and the queue")
    .action(() => {
      const s = readShare();
      const off = shareOff();
      const q = queued();
      console.log(off ? `off (${off})` : "on");
      console.log(`install  ${s.installId}`);
      console.log(`exclude  ${s.exclude.join(", ") || "none"}`);
      console.log(
        `queue    ${q.length} files, ${(q.reduce((n, f) => n + f.bytes, 0) / 1024).toFixed(0)} KB`,
      );
      console.log(`\n${NOTICE}`);
    });
  share
    .command("on")
    .description("share again")
    .action(() => {
      writeShare({ ...readShare(), off: false });
      console.log(shareOff() ? `still off: ${shareOff()}` : "on");
    });
  share
    .command("off")
    .description("stop sharing and delete the queue")
    .action(() => {
      writeShare({ ...readShare(), off: true });
      rmSync(join(shareRoot(), "queue"), { recursive: true, force: true });
      console.log("off; queue deleted");
    });
  share
    .command("exclude <site>")
    .description("never share this site (`linkedin`) or profile (`linkedin@wren`)")
    .action((site: string) => {
      const s = readShare();
      writeShare({ ...s, exclude: [...new Set([...s.exclude, site])].sort() });
      console.log(`excluded ${site}`);
    });
  share
    .command("include <site>")
    .description("take a site off the exclude list")
    .action((site: string) => {
      const s = readShare();
      writeShare({ ...s, exclude: s.exclude.filter((x) => x !== site) });
      console.log(`included ${site}`);
    });
  share
    .command("send")
    .description("upload the queue now")
    .action(async () => {
      const r = await sendShared({ budgetMs: 120_000 });
      console.log(
        `sent ${r.sent}, dropped ${r.dropped}, left ${r.left}${r.stopped ? ` (stopped: ${r.stopped})` : ""}`,
      );
    });
  registerShareKeep(share);
}

export function registerShareKeep(share: Command): void {
  share
    .command("keep")
    .description(
      "Wren only: run Presidio over the ingest's inbox and move it to kept/ (SHARE_ADMIN_TOKEN)",
    )
    .action(async () => {
      const token = process.env.SHARE_ADMIN_TOKEN;
      if (!token) throw new Error("SHARE_ADMIN_TOKEN not set");
      const { keepShared } = await import("../share/presidio.js");
      console.log(await keepShared(token));
    });
  const admin = async () => {
    const token = process.env.SHARE_ADMIN_TOKEN;
    if (!token) throw new Error("SHARE_ADMIN_TOKEN not set");
    return (await import("../share/presidio.js")).shareAdmin(token);
  };
  share
    .command("gate")
    .description("Wren only: static check over kept flow packs; a pass waits for review")
    .action(async () => {
      const { gateShared } = await import("../share/gate.js");
      console.log(await gateShared(await admin()));
    });
  share
    .command("review [id]")
    .description("Wren only: flow packs waiting for a yes; with an id, its steps and source")
    .option("--refused", "the refused ones and why")
    .action(async (id: string | undefined, o: { refused?: boolean }) => {
      const { heldPacks } = await import("../share/gate.js");
      const held = await heldPacks(await admin(), o.refused ? "refused" : "review");
      if (!id) {
        for (const h of held)
          console.log(
            `${h.id}  ${h.pack.site}  ${h.pack.proof.steps.length} steps  ${h.at.slice(0, 10)}${h.reasons.length ? `  ${h.reasons.join("; ")}` : ""}`,
          );
        if (!held.length) console.log("none");
        return;
      }
      const h = held.find((x) => x.id === id);
      if (!h) throw new Error(`no pack ${id}; see \`autobrowse share review\``);
      console.log(`${h.id}  site ${h.pack.site}  proof ${h.pack.proof.status} ${h.pack.proof.at}`);
      for (const st of h.pack.proof.steps) console.log(`  ${st.name}  ${st.status}  ${st.detail}`);
      for (const [f, body] of Object.entries(h.pack.files)) console.log(`\n--- ${f}\n${body}`);
    });
  share
    .command("approve <id>")
    .description("Wren only: yes to a pack: PR to the public registry, merged")
    .action(async (id: string) => {
      const { approvePack } = await import("../share/gate.js");
      console.log(await approvePack(await admin(), id));
    });
  share
    .command("refuse <id> <why>")
    .description("Wren only: no to a pack, with the reason")
    .action(async (id: string, why: string) => {
      const { refusePack } = await import("../share/gate.js");
      await refusePack(await admin(), id, why);
      console.log(`refused ${id}`);
    });
}

/** After a CLI command: a short send, so a CLI-only install empties its queue too. */
export async function sendAfterCommand(): Promise<void> {
  if (shareOff() || !queued().length) return;
  await sendShared({ budgetMs: 5_000 }).catch(() => undefined);
}
