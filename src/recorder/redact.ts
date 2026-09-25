/**
 * Secrets never enter a recording. Two gates: the field (password inputs,
 * names that say secret) and the value (token shapes). Either one masks.
 */
const SECRET_FIELD =
  /pass(word|wd|phrase)?|secret|token|api[-_ ]?key|private|credential|otp|code|pin|ssn|cvv|cvc|card|\bdsn\b|\bexp(iry|iration)?\b|mm\s*\/\s*yy|valid thru|name on/i;

const SECRET_VALUES: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/, // OpenAI / Anthropic-style
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Za-z0-9_-]{40,}\b/, // long opaque strings: Cloudflare tokens, Google keys
  /(?<=[a-z][a-z0-9+.-]*:\/\/)[^\s@/:]+(?::[^\s@/]*)?(?=@)/, // credentials in a URL: a Sentry DSN, a database URL
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

/** 13-19 digits, spaced or dashed as a card prints them. */
const CARD_RUN = /\b\d(?:[ -]?\d){12,18}\b/g;

/** Luhn over the digits: a card number, not an order id that happens to be long. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Mask secret-shaped substrings in free text (a terminal transcript), and anything that reads as a card number. */
export function redactText(text: string): string {
  let out = text;
  for (const re of SECRET_VALUES)
    out = out.replace(new RegExp(re.source, `${re.flags}g`), REDACTED);
  return out.replace(CARD_RUN, (run) => (luhnValid(run.replace(/\D/g, "")) ? REDACTED : run));
}

const FIELD_LINE = /^(\s*)-\s*(?:'|")?(?:textbox|searchbox|combobox)\s+"([^"]*)"[^:\n]*:/;

/**
 * An aria snapshot line for a filled field reads `- textbox "Enter your
 * password": <value>`, and Stripe's frames repeat the value on a child
 * `- text:` line. A field secret by name is masked whatever the value
 * looks like (a password is not token-shaped): its own value and every
 * child line's, but its placeholder. Then the usual text pass.
 */
export function redactAria(tree: string): string {
  const out: string[] = [];
  let secretAt = -1;
  for (const line of tree.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (secretAt >= 0 && indent > secretAt) {
      out.push(
        /^\s*-\s*\/placeholder:/.test(line) ? line : `${line.slice(0, indent)}- ${REDACTED}`,
      );
      continue;
    }
    secretAt = -1;
    const m = FIELD_LINE.exec(line);
    if (m && SECRET_FIELD.test(m[2] ?? "")) {
      secretAt = (m[1] ?? "").length;
      const head = m[0];
      out.push(line.slice(head.length).trim() ? `${head} ${REDACTED}` : line);
      continue;
    }
    out.push(line);
  }
  return redactText(out.join("\n"));
}
