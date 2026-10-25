/**
 * The secrets this process typed or read to type: passwords, sign-in codes. Held in
 * memory only, never written. The trace scrub (`trace-secrets.ts`) and the hands log
 * mask them (designs/2026-10-24-trace-secrets.md).
 */
const held = new Set<string>();

/** A shorter secret (a PIN) matches only a whole string: as a part it hits ids and dates. */
export const MATCH_MIN = 5;
/** Shorter still (a CVC) is not held: as a whole string it hits plain numbers. */
const HOLD_MIN = 4;

/** Hold `value` as a secret and give it back, so a read site wraps in place. */
export function secret<T extends string | null | undefined>(value: T): T {
  if (value && value.length >= HOLD_MIN) held.add(value);
  return value;
}

export const heldSecrets = (): string[] => [...held];

/** True when `text` holds a held secret. */
export function holdsSecret(text: string, among: Iterable<string> = held): boolean {
  if (!text) return false;
  for (const s of among) if (text === s || (s.length >= MATCH_MIN && text.includes(s))) return true;
  return false;
}
