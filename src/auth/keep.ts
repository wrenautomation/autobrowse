/**
 * autobrowse's names inside credvault (the vault, its own package): the
 * Keychain item that holds the seal key, the env prefix credentials travel
 * under, and the SSM path of the shared store. Changing any of them strands
 * what is already stored under the old one.
 */
export const KEYCHAIN = { service: "autobrowse" } as const;
export const CRED_ENV = { prefix: "AUTOBROWSE_CRED_" } as const;
/** Compiled workflows ask for `cardCvv` → `AUTOBROWSE_CARD_CVV`. */
export const SECRET_ENV_PREFIX = "AUTOBROWSE_";
export const ENV_STORE_PREFIX = "/autobrowse/config";
