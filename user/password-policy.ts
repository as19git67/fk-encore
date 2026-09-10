/**
 * One place to state how long a user-chosen password has to be.
 *
 * Before this, the three paths that accept a password disagreed: registration
 * and change-password checked nothing at all, and only the reset path had a
 * rule (6 characters). Raising the floor here raises it everywhere.
 *
 * Note what this does and does not buy. A length rule protects a user from
 * their own weak choice; it does nothing about somebody else guessing at the
 * account, which is what the per-account login limit in `auth.service.ts`
 * bounds. Existing passwords are never re-validated — the check runs when a
 * password is set, so nobody is locked out by a change here.
 */

/** Raise this to tighten the rule everywhere; nothing else needs touching. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Returns a human-readable reason the password is unacceptable, or null when
 * it passes. Returning rather than throwing lets each caller raise the error
 * type its layer uses — endpoints throw APIError, the reset path keeps the
 * plain Error its handler already maps.
 */
export function passwordPolicyError(password: string | undefined | null): string | null {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}
