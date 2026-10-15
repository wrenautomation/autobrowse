/**
 * An explore session is a lease on its browser profile. Nobody driving it for
 * `DEFAULT_IDLE_MINUTES` (no command, no page load) closes it, journal kept.
 * A scheduled write on the same profile (the desk posting) takes it after
 * `TAKE_IDLE_MINUTES` instead of waiting; a held session (`--hold`, teach)
 * is never taken (`browser/profile-wait`).
 */
export const DEFAULT_IDLE_MINUTES = 10;
export const TAKE_IDLE_MINUTES = 3;
