#!/usr/bin/env node
/**
 * `autobrowse cmd <json> [--port N]` with node builtins only: the explore wire
 * (token file, loopback POST) and nothing else. Same answer as the CLI's `cmd`.
 */
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Must match `tokenFileFor` in src/explore/journal.ts (test/explore-cmd.test.ts). */
export const tokenFileFor = (port) => join(tmpdir(), "autobrowse", `explore-${port}.token`);

export async function postCmd(port, body) {
  const tokenFile = tokenFileFor(port);
  if (!existsSync(tokenFile))
    throw new Error(`no explore session on ${port}: autobrowse explore <site> --background`);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/?wait=1`, {
      method: "POST",
      headers: { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15 * 60_000),
    });
    return { ok: res.ok, body: await res.text() };
  } catch (err) {
    return {
      ok: false,
      body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    };
  }
}

async function main(argv) {
  const at = argv.indexOf("--port");
  const port = Number(at < 0 ? 9090 : argv[at + 1]);
  const json = at < 0 ? argv[0] : argv.filter((_, i) => i !== at && i !== at + 1)[0];
  if (!json || !Number.isInteger(port)) {
    console.error("usage: autobrowse cmd '<json>' [--port 9090]");
    process.exit(2);
  }
  try {
    const res = await postCmd(port, JSON.parse(json));
    console.log(res.body);
    if (!res.ok) process.exitCode = 1;
  } catch (err) {
    console.error(`autobrowse cmd ${json} failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await main(process.argv.slice(2));
