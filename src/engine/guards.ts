/**
 * Guards are the situations where a person still gets a say: a purchase,
 * a password being set, a locator miss on something irreversible. Each is
 * a named gate. All are on by default; `GUARDS` turns them off one by
 * one (`GUARDS=none` runs everything unattended). A gate whose guard is
 * off answers itself "approved" and the run keeps going.
 */
export const GUARDS = ["purchase", "password", "irreversible"] as const;
export type Guard = (typeof GUARDS)[number];
export type Guards = ReadonlySet<Guard>;

export const ALL_GUARDS: Guards = new Set(GUARDS);

/** `all` (default), `none`, or a comma list of the guards to keep. Unknown names throw. */
export function parseGuards(text: string | undefined): Guards {
  const t = (text ?? "all").trim().toLowerCase();
  if (t === "all" || t === "") return ALL_GUARDS;
  if (t === "none") return new Set();
  const out = new Set<Guard>();
  for (const name of t
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!(GUARDS as readonly string[]).includes(name))
      throw new Error(`GUARDS: unknown guard ${name}; one of ${GUARDS.join(", ")}`);
    out.add(name as Guard);
  }
  return out;
}

export function isGuard(name: string): name is Guard {
  return (GUARDS as readonly string[]).includes(name);
}
