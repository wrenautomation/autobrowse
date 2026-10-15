/**
 * Accounts into Bitwarden: the break-glass copy that lives outside AWS, so losing the AWS account
 * (or the Mac) never loses the logins that get it back. The `bw` CLI (`npm i -g @bitwarden/cli`)
 * is logged in once; each run unlocks it with the master password stored under `bitwarden`,
 * writes one login per account (named `autobrowse · <key>`, updated in place), then locks.
 * Secrets travel by env and stdin only: never argv, never printed.
 */
import { execFile } from "node:child_process";

export interface BitwardenRow {
  /** The stored key (`google@admin`). */
  key: string;
  url: string;
  username: string;
  password?: string;
  /** otpauth://totp/… for the login's authenticator. */
  otpauth?: string;
  notes: string;
}

export const ITEM_PREFIX = "autobrowse · ";

/** The parts of a Bitwarden login item this writes; anything else on an existing item is kept. */
export function bitwardenItem(row: BitwardenRow, existing: Record<string, unknown> = {}) {
  const login = (existing.login as Record<string, unknown> | undefined) ?? {};
  return {
    ...existing,
    type: 1,
    name: `${ITEM_PREFIX}${row.key}`,
    notes: row.notes,
    login: {
      ...login,
      username: row.username,
      password: row.password ?? null,
      totp: row.otpauth ?? null,
      uris: [{ uri: row.url, match: null }],
    },
  };
}

interface ItemView {
  name?: string;
  notes?: string | null;
  login?: {
    username?: string | null;
    password?: string | null;
    totp?: string | null;
    uris?: { uri?: string }[];
  };
}

/** The fields a row writes; equal on both sides = nothing to write. */
const written = (i: ItemView) =>
  JSON.stringify([
    i.name,
    i.notes ?? null,
    i.login?.username ?? null,
    i.login?.password ?? null,
    i.login?.totp ?? null,
    i.login?.uris?.[0]?.uri ?? null,
  ]);

/** Runs `bw <args>` with extra env and stdin; resolves stdout. */
export type BwRun = (
  args: string[],
  o?: { env?: Record<string, string>; input?: string },
) => Promise<string>;

export const bwCli: BwRun = (args, o = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      process.env.BW_BIN ?? "bw",
      args,
      { env: { ...process.env, ...o.env }, maxBuffer: 64 << 20 },
      (err, stdout, stderr) => {
        // bw's errors name the command, never a value we passed by env or stdin.
        if (err)
          reject(
            new Error(`bw ${args[0]}: ${String(stderr).trim().split("\n").pop() || err.message}`),
          );
        else resolve(String(stdout));
      },
    );
    child.stdin?.end(o.input ?? "");
  });

export interface SyncResult {
  created: string[];
  updated: string[];
  kept: string[];
}

export async function syncBitwarden(
  rows: readonly BitwardenRow[],
  masterPassword: string,
  run: BwRun = bwCli,
): Promise<SyncResult> {
  const session = (
    await run(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], {
      env: { BW_PASSWORD: masterPassword },
    })
  ).trim();
  if (!session) throw new Error("bw unlock gave no session (is `bw login` done?)");
  const env = { BW_SESSION: session };
  const out: SyncResult = { created: [], updated: [], kept: [] };
  try {
    await run(["sync"], { env });
    const items = JSON.parse(
      await run(["list", "items", "--search", ITEM_PREFIX.trim()], { env }),
    ) as {
      id: string;
      name: string;
    }[];
    const byName = new Map(
      items.filter((i) => i.name.startsWith(ITEM_PREFIX)).map((i) => [i.name, i]),
    );
    for (const row of rows) {
      const had = byName.get(`${ITEM_PREFIX}${row.key}`) as
        | (Record<string, unknown> & { id: string })
        | undefined;
      const item = bitwardenItem(row, had);
      if (had && written(item) === written(had as ItemView)) {
        out.kept.push(row.key);
        continue;
      }
      const input = Buffer.from(JSON.stringify(item)).toString("base64");
      if (had) {
        await run(["edit", "item", had.id], { env, input });
        out.updated.push(row.key);
      } else {
        await run(["create", "item"], { env, input });
        out.created.push(row.key);
      }
    }
  } finally {
    await run(["lock"], { env }).catch(() => {});
  }
  return out;
}
