/**
 * wren's roster (`senders_config.toml`) lives in one SSM parameter. Adding
 * inboxes means appending `[[senders]]` entries; nothing already there is
 * rewritten, so comments and the signature survive.
 */
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { parse } from "smol-toml";
import type { AwsConfig } from "../owner.js";

export interface RosterEntry {
  address: string;
  displayName: string;
  niches: "all" | string[];
}

export interface RosterStore {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

/** One SecureString parameter read and written whole: the roster, the mailbox logins. */
export function ssmTextStore(opts: { param: string; aws: AwsConfig }): RosterStore {
  const ssm = new SSMClient(opts.aws);
  return {
    async read() {
      const r = await ssm.send(new GetParameterCommand({ Name: opts.param, WithDecryption: true }));
      const value = r.Parameter?.Value;
      if (typeof value !== "string") throw new Error(`SSM ${opts.param} has no value`);
      return value;
    },
    async write(text) {
      await ssm.send(
        new PutParameterCommand({
          Name: opts.param,
          Value: text,
          Type: "SecureString",
          Tier: "Advanced",
          Overwrite: true,
        }),
      );
    },
  };
}

export function rosterAddresses(text: string): string[] {
  const data = parse(text) as { senders?: Array<{ address?: unknown }> };
  return (data.senders ?? [])
    .map((s) => s.address)
    .filter((a): a is string => typeof a === "string")
    .map((a) => a.toLowerCase());
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

export function renderEntry(e: RosterEntry): string {
  const niches = e.niches === "all" ? '"all"' : `[${e.niches.map(tomlString).join(", ")}]`;
  return `\n[[senders]]\naddress = ${tomlString(e.address.toLowerCase())}\ndisplay_name = ${tomlString(e.displayName)}\nniches = ${niches}\n`;
}

/** The roster with `entries` appended, minus any already present. Returns the text and what was added. */
export function appendEntries(
  text: string,
  entries: RosterEntry[],
): { text: string; added: string[] } {
  const present = new Set(rosterAddresses(text));
  const added: string[] = [];
  let out = text.endsWith("\n") ? text : `${text}\n`;
  for (const e of entries) {
    const address = e.address.toLowerCase();
    if (present.has(address)) continue;
    out += renderEntry(e);
    present.add(address);
    added.push(address);
  }
  // The result must still parse: a malformed append would take the whole fleet down at the next cold start.
  rosterAddresses(out);
  return { text: out, added };
}
