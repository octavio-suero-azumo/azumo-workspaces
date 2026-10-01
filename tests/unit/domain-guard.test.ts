import { describe, expect, it } from "vitest";
import { evaluateGoogleIdentity } from "@/server/auth/domain-guard";

// TC-04 / AC-05 / R1.2: the defensive check. Placeholder domains only.
const ALLOWED = "allowed.test";

describe("evaluateGoogleIdentity (TC-04)", () => {
  it("accepts hd equal to the configured domain with email_verified=true", () => {
    expect(evaluateGoogleIdentity({ hd: ALLOWED, emailVerified: true }, ALLOWED)).toEqual({ ok: true });
  });

  it("compares hd case-insensitively", () => {
    expect(evaluateGoogleIdentity({ hd: "Allowed.TEST", emailVerified: true }, ALLOWED)).toEqual({ ok: true });
  });

  it("rejects email_verified=false", () => {
    expect(evaluateGoogleIdentity({ hd: ALLOWED, emailVerified: false }, ALLOWED)).toEqual({
      ok: false,
      reason: "email_not_verified",
    });
  });

  it.each([undefined, null, "true", 1])("rejects non-boolean-true email_verified %j", (emailVerified) => {
    expect(evaluateGoogleIdentity({ hd: ALLOWED, emailVerified }, ALLOWED)).toEqual({
      ok: false,
      reason: "email_not_verified",
    });
  });

  it.each([undefined, null, "", "   ", 42])("rejects missing hd %j (e.g. personal Gmail)", (hd) => {
    expect(evaluateGoogleIdentity({ hd, emailVerified: true }, ALLOWED)).toEqual({
      ok: false,
      reason: "hd_missing",
    });
  });

  it.each(["other.test", "sub.allowed.test", "allowed.test.evil", "allowed"])(
    "rejects a different hd %s",
    (hd) => {
      expect(evaluateGoogleIdentity({ hd, emailVerified: true }, ALLOWED)).toEqual({
        ok: false,
        reason: "hd_mismatch",
      });
    },
  );

  it.each(["", "   ", "*"])("fails closed when the configured domain is %j", (configured) => {
    expect(evaluateGoogleIdentity({ hd: ALLOWED, emailVerified: true }, configured)).toEqual({
      ok: false,
      reason: "config_invalid",
    });
  });

  it("does not accept a wildcard configured domain even when hd is present", () => {
    expect(evaluateGoogleIdentity({ hd: "anything.test", emailVerified: true }, "*").ok).toBe(false);
  });
});
