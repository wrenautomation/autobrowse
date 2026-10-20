/**
 * IMAP sessions for an inbox on its own login. Logins hold passwords, so no message here
 * ever quotes a value: only addresses and keys.
 */
import { ImapFlow } from "imapflow";

/** One server login. */
export interface Login {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
}

/** A client for this login: TLS on 993, STARTTLS required elsewhere; no logger, which would print the login. */
export function imapClient(login: Login): ImapFlow {
  const secure = login.port === 993;
  return new ImapFlow({
    host: login.host,
    port: login.port,
    secure,
    doSTARTTLS: secure ? undefined : true,
    auth: { user: login.user, pass: login.pass },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
}

/** One session: connect, run, log out (close when the logout fails). */
export async function withImap<T>(
  client: ImapFlow,
  run: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  // A dropped socket rejects the command in flight; the bare event must not crash the process.
  client.on("error", () => {});
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** The folder flagged `use` (`\Sent`, `\Junk`), or null. */
export async function specialFolder(client: ImapFlow, use: string): Promise<string | null> {
  return (await client.list()).find((f) => f.specialUse === use)?.path ?? null;
}

/** `run` with `path` open read-only (EXAMINE: no flag ever changes), given its UIDVALIDITY. */
export async function inFolder<T>(
  client: ImapFlow,
  path: string,
  run: (uidValidity: string) => Promise<T>,
): Promise<T> {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    if (!client.mailbox) throw new Error(`imap: ${path} did not open`);
    return await run(String(client.mailbox.uidValidity));
  } finally {
    lock.release();
  }
}
