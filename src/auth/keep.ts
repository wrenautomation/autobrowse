/**
 * autobrowse's names inside credvault (the vault, its own package): the
 * Keychain item that holds the seal key, the env prefix credentials travel
 * under. The SSM path is the owner's (src/owner.ts). Changing any of them
 * strands what is already stored under the old one.
 */
import { checkOwner, isDefaultOwner } from "../owner.js";

export const KEYCHAIN = { service: "autobrowse" } as const;
/**
 * An owner's own seal key. `autobrowse-owner-<owner>`, never `autobrowse-<owner>`:
 * an owner named `wallet` would otherwise open the operator's cards.
 */
export const keychainOf = (owner: string): { service: string } =>
  isDefaultOwner(owner) ? KEYCHAIN : { service: `${KEYCHAIN.service}-owner-${checkOwner(owner)}` };
/** The wallet's own key: opening credentials never opens cards. The operator's only. */
export const WALLET_KEYCHAIN = { service: "autobrowse-wallet" } as const;
export const CRED_ENV = { prefix: "AUTOBROWSE_CRED_" } as const;
/** Compiled workflows ask for `cardCvv` → `AUTOBROWSE_CARD_CVV`. */
export const SECRET_ENV_PREFIX = "AUTOBROWSE_";
