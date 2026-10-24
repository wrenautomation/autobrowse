/**
 * `fetch` for the share ingest that survives a stale negative DNS cache.
 * macOS mDNSResponder can keep "no such host" for a new subdomain for hours
 * (share.wrenautomation.com, 2026-10-24), and only root can flush it. On
 * ENOTFOUND the call goes again with the host resolved by public resolvers.
 */
import { Resolver } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";

const MISSING = new Set(["ENOTFOUND", "EAI_AGAIN"]);

const codeOf = (err: unknown): string | undefined =>
  (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;

let agent: Agent | undefined;

/** An agent whose lookup asks 1.1.1.1 and 8.8.8.8, not this machine's cache. */
function publicAgent(): Agent {
  if (agent) return agent;
  const dns = new Resolver();
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
  agent = new Agent({
    connect: {
      lookup: (host, opts, cb) => {
        dns.resolve4(host).then(
          (addrs) => {
            const all = addrs.map((address) => ({ address, family: 4 }));
            if ((opts as { all?: boolean }).all) cb(null, all as never);
            else cb(null, addrs[0] as string, 4);
          },
          (err: NodeJS.ErrnoException) => cb(err, "", 4),
        );
      },
    },
  });
  return agent;
}

export const shareFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (err) {
    if (!MISSING.has(codeOf(err) ?? "")) throw err;
    return (await undiciFetch(input as string, {
      ...(init as object),
      dispatcher: publicAgent(),
    })) as unknown as Response;
  }
};
