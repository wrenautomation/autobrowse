/**
 * Where a credential the tool minted goes: the local `.env` (0600, one
 * key upserted, the running process updated too so lazy deps see it) or
 * SSM in production. The counterpart of `SecretSource`. A minted token
 * that lapses says when (`expiresAt`), so `needs` reopens its row in time.
 */
import { envFileStore, type PutOptions } from "credvault";

export interface SecretSink {
  put(name: string, value: string, o?: PutOptions): Promise<void>;
}

/** Upsert `NAME=value` in an env file; other lines untouched; also sets `process.env` so this process sees it. */
export function envFileSink(path: string, env: NodeJS.ProcessEnv = process.env): SecretSink {
  return envFileStore(path, env);
}

export function memorySink(): SecretSink & {
  values: Record<string, string>;
  expires: Record<string, string>;
} {
  const values: Record<string, string> = {};
  const expires: Record<string, string> = {};
  return {
    values,
    expires,
    async put(name, value, o) {
      values[name] = value;
      if (o?.expiresAt) expires[name] = o.expiresAt;
      else delete expires[name];
    },
  };
}
