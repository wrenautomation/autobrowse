/**
 * Where a compiled workflow gets a value the recorder redacted. The
 * plan never carries secrets (it is journaled); a step asks for one by
 * key at the moment it needs it. Env is the default source; SSM or a
 * vault is one more implementation.
 */
export interface SecretSource {
  get(key: string): Promise<string>;
}

/** A key as the recorder names it (`cardCvv`) → `AUTOBROWSE_CARD_CVV` in the environment. */
export function envSecrets(
  env: NodeJS.ProcessEnv = process.env,
  prefix = "AUTOBROWSE_",
): SecretSource {
  return {
    async get(key) {
      const name = `${prefix}${key
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .toUpperCase()}`;
      const value = env[name];
      if (!value) throw new Error(`secret ${key}: set ${name}`);
      return value;
    },
  };
}

export function memorySecrets(values: Record<string, string>): SecretSource {
  return {
    async get(key) {
      const v = values[key];
      if (v === undefined) throw new Error(`secret ${key}: not set`);
      return v;
    },
  };
}
