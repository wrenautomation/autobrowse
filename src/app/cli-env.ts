/**
 * `autobrowse env …`: secrets in and out of the store (SSM) from any
 * machine with AWS access. Values never land in argv or on the screen
 * unless asked: the clipboard (cleared after a minute; Universal Clipboard
 * carries it to a phone), `export` lines for `eval`, or a 0600 env file.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import {
  type EnvEntry,
  type EnvStore,
  parseDotenv,
  toDotenv,
  toExports,
  upsertDotenv,
} from "credvault";
import { expandHome } from "../google-auth.js";
import type { Settings } from "./config.js";

export interface EnvCliDeps {
  store: () => EnvStore;
  /** Put text on the clipboard and clear it after `clearAfterMs` if still there. */
  clipboard?: (text: string, clearAfterMs: number) => Promise<void>;
  say?: (line: string) => void;
  out?: (text: string) => void;
}

const CLEAR_MS = 60_000;

/** macOS: pbcopy now, and a detached shell that empties it in a minute only if it still holds this value (compared by hash). */
export async function macClipboard(text: string, clearAfterMs: number): Promise<void> {
  if (process.platform !== "darwin") throw new Error("clipboard needs macOS; use --print or pull");
  await new Promise<void>((res, rej) => {
    const p = execFile("pbcopy", (err) => (err ? rej(err) : res()));
    p.stdin?.end(text);
  });
  const hash = createHash("sha256").update(text).digest("hex");
  const secs = Math.ceil(clearAfterMs / 1000);
  spawn(
    "sh",
    [
      "-c",
      `sleep ${secs}; [ "$(pbpaste | shasum -a 256 | cut -d' ' -f1)" = "${hash}" ] && pbcopy </dev/null`,
    ],
    { detached: true, stdio: "ignore" },
  ).unref();
}

/** Names that describe the machine, not the fleet: a blanket `pull` leaves them alone. */
export const MACHINE_LOCAL = new Set(["CREDENTIALS_CIPHER", "BROWSER", "BROWSER_HEADLESS"]);

export function registerEnvCommands(program: Command, settings: Settings, deps: EnvCliDeps): void {
  const say = deps.say ?? ((l: string) => console.log(l));
  const out = deps.out ?? ((t: string) => process.stdout.write(t));
  const clipboard = deps.clipboard ?? macClipboard;
  const env = program
    .command("env")
    .description(
      "Secrets in and out of the store (SSM /autobrowse/config): the same values on every machine and the prod box",
    );

  env
    .command("ls")
    .description("Names in the store, when each changed and when it lapses; never values")
    .action(async () => {
      const rows = await deps.store().list();
      if (!rows.length) return say("(empty)");
      for (const r of rows)
        say(
          `${r.name.padEnd(32)} ${(r.updatedAt ?? "").padEnd(24)} ${r.expiresAt ? `expires ${r.expiresAt}` : ""}`.trimEnd(),
        );
    });

  env
    .command("get <name>")
    .description(
      "One value to the clipboard (emptied after a minute); --print writes it to stdout instead",
    )
    .option("--print", "stdout instead of the clipboard (for a pipe)")
    .action(async (name: string, o: { print?: boolean }) => {
      const value = await deps.store().get(name);
      if (value === null) throw new Error(`${name} is not in the store`);
      if (o.print) return out(value);
      await clipboard(value, CLEAR_MS);
      say(`${name} is on the clipboard for ${CLEAR_MS / 1000}s`);
    });

  env
    .command("pull [names...]")
    .description(
      'Values from the store into an env file (merged, 0600; default .env), or --export for eval "$(autobrowse env pull --export)"',
    )
    .option("--out <file>", "env file to upsert into", settings.envFile)
    .option("--export", "print `export NAME='…'` lines to stdout instead of writing a file")
    .option("--stdout", "print KEY=VALUE lines to stdout instead of writing a file")
    .action(async (names: string[], o: { out: string; export?: boolean; stdout?: boolean }) => {
      const all = await deps.store().all();
      const missing = names.filter((n) => !all.some((e) => e.name === n));
      if (missing.length) throw new Error(`not in the store: ${missing.join(", ")}`);
      const chosen = names.length ? all.filter((e) => names.includes(e.name)) : all;
      // The store is the fleet's; a few names describe THIS machine and a blanket
      // pull would hand it the box's answer (a sealed credential file read as plain).
      const entries = names.length ? chosen : chosen.filter((e) => !MACHINE_LOCAL.has(e.name));
      const kept = chosen.length - entries.length;
      if (o.export) return out(toExports(entries));
      const file = resolve(expandHome(o.out));
      // A multi-line value (a service-account JSON) goes to its own 0600 file beside the env file.
      const sidecars: Array<[string, string]> = [];
      const text = toDotenv(entries, (name, value) => {
        const path = join(dirname(file), `${name.toLowerCase()}.json`);
        sidecars.push([path, value]);
        return path;
      });
      if (o.stdout) return out(text);
      await mkdir(dirname(file), { recursive: true });
      for (const [path, value] of sidecars) await writeSecretFile(path, value);
      const current = existsSync(file) ? await readFile(file, "utf8") : "";
      await writeSecretFile(
        file,
        upsertDotenv(
          current,
          entries.map((e) => ({
            name: e.name,
            value: /[\r\n]/.test(e.value)
              ? (sidecars.find(([p]) => p.endsWith(`${e.name.toLowerCase()}.json`))?.[0] ?? "")
              : e.value,
          })),
        ),
      );
      say(
        `${entries.length} value${entries.length === 1 ? "" : "s"} → ${file}: ${entries.map((e) => e.name).join(", ")}`,
      );
      if (kept)
        say(
          `kept this machine's own: ${[...MACHINE_LOCAL].join(", ")} (name one explicitly to pull it anyway)`,
        );
    });

  env
    .command("push [names...]")
    .description(
      "Values from an env file into the store: named ones from .env, or every key of --from <file>",
    )
    .option("--from <file>", "env file to read (default .env; required when no names are given)")
    .action(async (names: string[], o: { from?: string }) => {
      if (!names.length && !o.from)
        throw new Error("name what to push, or --from <file> to push every key in a file");
      const file = resolve(expandHome(o.from ?? settings.envFile));
      const entries = parseDotenv(readFileSync(file, "utf8"), (p) =>
        existsSync(expandHome(p)) ? readFileSync(expandHome(p), "utf8") : null,
      );
      const chosen = names.length ? entries.filter((e) => names.includes(e.name)) : entries;
      const missing = names.filter((n) => !chosen.some((e) => e.name === n));
      if (missing.length) throw new Error(`not in ${file}: ${missing.join(", ")}`);
      const store = deps.store();
      for (const e of chosen) await store.put(e.name, e.value);
      say(`pushed ${chosen.length}: ${chosen.map((e) => e.name).join(", ")}`);
      say("the box reads the store on its next deploy (push to main)");
    });

  env
    .command("expires <name> <when>")
    .description(
      "Record when a value lapses (an ISO date, or `none`) without printing it: for a token minted by hand, or before expiry was kept",
    )
    .action(async (name: string, when: string) => {
      const store = deps.store();
      const value = await store.get(name);
      if (value === null) throw new Error(`${name} is not in the store`);
      const at = when === "none" ? undefined : new Date(when);
      if (at && Number.isNaN(at.getTime())) throw new Error(`not a date: ${when}`);
      await store.put(name, value, at ? { expiresAt: at.toISOString() } : {});
      say(at ? `${name} expires ${at.toISOString()}` : `${name}: no expiry`);
    });

  env
    .command("rm <name>")
    .description("Remove one value from the store")
    .action(async (name: string) => {
      say((await deps.store().remove(name)) ? `removed ${name}` : `${name} was not in the store`);
    });
}

async function writeSecretFile(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export type { EnvEntry };
