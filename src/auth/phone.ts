/** A phone number as forms want it: whole (E.164) or split from its country code. */

/** `+15875550100` → `5875550100`: the national part, for a field whose country code is a picker (only +1 is split; other codes stay as digits). */
export function localPhone(e164: string): string {
  const digits = e164.replace(/[^\d]/g, "");
  if (e164.startsWith("+1") || (digits.length === 11 && digits.startsWith("1")))
    return digits.slice(1);
  return digits;
}

/** "+1 (US/Canada)" or the code alone: what to pick in a country selector. */
export function phoneCountry(e164: string): string {
  if (e164.startsWith("+1")) return "+1 (Canada or United States)";
  const m = e164.match(/^\+(\d{1,3})/);
  return m ? `+${m[1]}` : "the number's own";
}
