/** Is the domain registered? RDAP is the registry's own answer: 404 = nobody holds it. */
import type { FetchLike } from "../google-auth.js";

export type Availability = "available" | "taken" | "unknown";

export async function domainAvailability(
  domain: string,
  doFetch: FetchLike = fetch,
): Promise<Availability> {
  const response = await doFetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
    headers: { accept: "application/rdap+json" },
  });
  if (response.status === 404) return "available";
  if (response.ok) return "taken";
  return "unknown";
}
