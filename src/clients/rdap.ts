/** Is the domain registered? RDAP is the registry's own answer: 404 = nobody holds it. */
import type { HttpClient } from "./http.js";

export type Availability = "available" | "taken" | "unknown";

export async function domainAvailability(http: HttpClient, domain: string): Promise<Availability> {
  const r = await http.json(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
    headers: { accept: "application/rdap+json" },
  });
  if (r.status === 404) return "available";
  if (r.ok) return "taken";
  return "unknown";
}
