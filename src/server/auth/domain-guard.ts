/**
 * Defensive Google identity check (R1.2, AC-05, RK-1).
 *
 * Accepts only when the Google identity carries `email_verified === true` and
 * an `hd` (hosted domain) claim equal, case-insensitively, to the configured
 * allowed domain. The allowed domain always comes from `ALLOWED_GOOGLE_HD`;
 * no domain literal lives in the source (R1.3).
 *
 * The email address's own domain is deliberately NOT inspected: R1.2 defines
 * the rule as `hd` + `email_verified` (see PRD §4 R1.2 / AC-05).
 */

export type GoogleIdentityRejection =
  | "config_invalid"
  | "hd_missing"
  | "hd_mismatch"
  | "email_not_verified";

export type GoogleIdentityVerdict = { ok: true } | { ok: false; reason: GoogleIdentityRejection };

export interface GoogleIdentityClaims {
  /** The `hd` claim (or the value persisted from it). Untrusted input. */
  hd?: unknown;
  /** The `email_verified` claim (or the persisted `emailVerified`). Untrusted input. */
  emailVerified?: unknown;
}

export function evaluateGoogleIdentity(
  claims: GoogleIdentityClaims,
  allowedHd: string,
): GoogleIdentityVerdict {
  // Fail closed on a missing/blank/wildcard configuration even if env
  // validation was somehow bypassed.
  const allowed = typeof allowedHd === "string" ? allowedHd.trim().toLowerCase() : "";
  if (allowed.length === 0 || allowed.includes("*")) {
    return { ok: false, reason: "config_invalid" };
  }

  if (claims.emailVerified !== true) {
    return { ok: false, reason: "email_not_verified" };
  }

  if (typeof claims.hd !== "string" || claims.hd.trim().length === 0) {
    return { ok: false, reason: "hd_missing" };
  }

  if (claims.hd.trim().toLowerCase() !== allowed) {
    return { ok: false, reason: "hd_mismatch" };
  }

  return { ok: true };
}

/** Human-readable text for a rejection. Never includes the configured domain. */
export const GOOGLE_IDENTITY_REJECTION_MESSAGES: Readonly<Record<GoogleIdentityRejection, string>> =
  Object.freeze({
    config_invalid: "Sign-in is not available: the allowed domain is not configured.",
    hd_missing: "Only accounts from the authorized Google Workspace domain can sign in.",
    hd_mismatch: "Only accounts from the authorized Google Workspace domain can sign in.",
    email_not_verified: "Your Google account email is not verified.",
  });
