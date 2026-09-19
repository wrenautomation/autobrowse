/**
 * Where a credential the tool minted goes: the local `.env` (0600, one
 * key upserted, the running process updated too so lazy deps see it) or
 * SSM in production. The counterpart of `SecretSource`.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { expandHome } from "../google-auth.js";

export interface SecretSink {
  put(name: string, value: string): Promise<void>;
}

const KEY = /^[A-Z][A-Z0-9_]*$/;

/** Upsert `NAME=value` in an env file; other lines untouched; also sets `process.env` so this process sees it. */
export function envFileSink(path: string, env: NodeJS.ProcessEnv = process.env): SecretSink {
  const file = expandHome(path);
  return {
    async put(name, value) {
      if (!KEY.test(name)) throw new Error(`env sink: bad key ${name}`);
      if (/[\r\n]/.test(value)) throw new Error(`env sink: ${name} value has a newline`);
      const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
      if (lines.at(-1) === "") lines.pop();
      const line = `${name}=${value}`;
      const i = lines.findIndex((l) => l.startsWith(`${name}=`));
      if (i >= 0) lines[i] = line;
      else lines.push(line);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      env[name] = value;
    },
  };
}

export function memorySink(): SecretSink & { values: Record<string, string> } {
  const values: Record<string, string> = {};
  return {
    values,
    async put(name, value) {
      values[name] = value;
    },
  };
}
