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
import { isDefaultOwner } from "../owner.js";
import type { Settings } from "./config.js";

export interface EnvCliDeps {
  store: () => EnvStore;
  /** Put text on the clipboard and clear it after `clearAfterMs` if still there. */
  clipboard?: (text: string, clearAfterMs: number) => Promise<void>;
  say?: (line: string) => void;
  out?: (text: string) => void;
  /** What is on the clipboard, for `set --clipboard`. */
  paste?: () => Promise<string>;
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
export const MACHINE_LOCAL = new Set([
  "CREDENTIALS_CIPHER",
  "BROWSER",
  "BROWSER_HEADLESS",
  "SENTRY_ENVIRONMENT",
]);

export function registerEnvCommands(program: Command, settings: Settings, deps: EnvCliDeps): void {
  const say = deps.say ?? ((l: string) => console.log(l));
  const out = deps.out ?? ((t: string) => process.stdout.write(t));
  const clipboard = deps.clipboard ?? macClipboard;
  // Only the default owner's store feeds the box; an owner's worker reads its own at boot.
  const boxHint = () => {
    if (isDefaultOwner(settings.owner))
      say("the box reads the store on its next deploy (push to main)");
  };
  const env = program
    .command("env")
    .description(
      "Secrets in and out of the store (SSM /autobrowse/config; an owner's /autobrowse/owners/<owner>/config): the same values on every machine and the prod box",
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
      if (o.from && !existsSync(file)) throw new Error(`no such file: ${file}`);
      // No .env on this machine yet: every named value has to be in the store already.
      const entries = existsSync(file)
        ? parseDotenv(readFileSync(file, "utf8"), (p) =>
            existsSync(expandHome(p)) ? readFileSync(expandHome(p), "utf8") : null,
          )
        : [];
      const chosen = names.length ? entries.filter((e) => names.includes(e.name)) : entries;
      const missing = names.filter((n) => !chosen.some((e) => e.name === n));
      const store = deps.store();
      if (missing.length) {
        // Not in the file but already in the store (`env set` put it there): nothing to push.
        const there = new Set((await store.list()).map((r) => r.name));
        const absent = missing.filter((n) => !there.has(n));
        if (absent.length)
          throw new Error(
            `not in ${file} or the store: ${absent.join(", ")} (a new one: autobrowse env set NAME --clipboard)`,
          );
        say(`already in the store, not in ${file}: ${missing.join(", ")}`);
      }
      for (const e of chosen) await store.put(e.name, e.value);
      if (chosen.length) say(`pushed ${chosen.length}: ${chosen.map((e) => e.name).join(", ")}`);
      boxHint();
    });

  env
    .command("set <name>")
    .description(
      "One new value into the store without a file: --clipboard takes what is copied; otherwise piped stdin, or a hidden prompt",
    )
    .option("--clipboard", "read the value from the clipboard (macOS)")
    .option("--out <file>", "env file that gets it too (merged, 0600)", settings.envFile)
    .option("--store-only", "the store alone, not the local env file")
    .action(async (name: string, o: { clipboard?: boolean; out: string; storeOnly?: boolean }) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`not an env name: ${name}`);
      const value = cleanValue(
        name,
        o.clipboard ? await (deps.paste ?? pasteboard)() : await secretInput(name),
      );
      await deps.store().put(name, value);
      say(`set ${name} in the store (${value.length} chars)`);
      if (!o.storeOnly) {
        const file = resolve(expandHome(o.out));
        await mkdir(dirname(file), { recursive: true });
        const current = existsSync(file) ? await readFile(file, "utf8") : "";
        await writeSecretFile(file, upsertDotenv(current, [{ name, value }]));
        say(`and in ${file}`);
      }
      boxHint();
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

/**
 * A pasted value as it is meant: blank edges gone, a whole `NAME=value`
 * line or surrounding quotes cut down to the value. A multi-line value is
 * only taken when it is JSON (a service-account key).
 */
export function cleanValue(name: string, raw: string): string {
  let v = raw.trim();
  const line = new RegExp(`^(export\\s+)?${name}=`);
  if (line.test(v)) v = v.replace(line, "").trim();
  if (/^(['"]).*\1$/s.test(v)) v = v.slice(1, -1);
  if (!v) throw new Error("empty value; nothing stored");
  if (/[\r\n]/.test(v) && !/^[{[]/.test(v))
    throw new Error("the value has line breaks; copy just the value");
  return v;
}

/** What is on the macOS clipboard. */
function pasteboard(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("--clipboard needs macOS; pipe it in instead");
  return new Promise((res, rej) =>
    execFile("pbpaste", (err, stdout) => (err ? rej(err) : res(stdout))),
  );
}

/** Piped stdin, or a prompt that echoes nothing. */
async function secretInput(name: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    let text = "";
    for await (const chunk of stdin) text += chunk;
    return text;
  }
  stderr.write(`${name} (hidden): `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((res, rej) => {
    let text = "";
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
      err ? rej(err) : res(text);
    };
    const onData = (s: string) => {
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f") text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function writeSecretFile(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export type { EnvEntry };
