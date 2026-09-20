/**
 * Secrets never enter a recording. Two gates: the field (password inputs,
 * names that say secret) and the value (token shapes). Either one masks.
 */
const SECRET_FIELD =
  /pass(word|wd|phrase)?|secret|token|api[-_ ]?key|private|credential|otp|code|pin|ssn|cvv|card/i;

const SECRET_VALUES: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/, // OpenAI / Anthropic-style
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Za-z0-9_-]{40,}\b/, // long opaque strings: Cloudflare tokens, Google keys
];

export const REDACTED = "<redacted>";

export function looksLikeSecretField(hints: {
  name?: string | null;
  placeholder?: string | null;
  id?: string | null;
  inputType?: string | null;
}): boolean {
  if (hints.inputType === "password") return true;
  return [hints.name, hints.placeholder, hints.id].some((h) => h && SECRET_FIELD.test(h));
}

export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUES.some((re) => re.test(value));
}

/** Mask secret-shaped substrings in free text (a terminal transcript). */
export function redactText(text: string): string {
  let out = text;
  for (const re of SECRET_VALUES)
    out = out.replace(new RegExp(re.source, `${re.flags}g`), REDACTED);
  return out;
}

/**
 * An aria snapshot line for a filled field reads `- textbox "Enter your
 * password": <value>`. Masked when the field is secret by name, whatever
 * the value looks like: a password is not token-shaped. Then the usual
 * text pass for values that are.
 */
export function redactAria(tree: string): string {
  const masked = tree.replace(
    /^(\s*-\s*(?:'|")?(?:textbox|searchbox|combobox)\s+"([^"]*)"[^:\n]*):\s+(?!\n)(.+)$/gm,
    (line, head: string, name: string) => (SECRET_FIELD.test(name) ? `${head}: ${REDACTED}` : line),
  );
  return redactText(masked);
}
