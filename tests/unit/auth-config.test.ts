import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUTH_DISABLED_PATHS, AuthConfigError, buildAuthOptions } from "@/server/auth/config";
import type { AppDatabase } from "@/server/db/client";
import { parseEnv, type EnvSource } from "@/server/env";

// AC-36 (config part) / R1.1 / R1.3 / architecture §4.9.
// The DB is never touched here: building options only wires the adapter.
const fakeDb = {} as AppDatabase;

function env(overrides: EnvSource = {}) {
  return parseEnv({
    ALLOWED_GOOGLE_HD: "allowed.test",
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    GOOGLE_CLIENT_ID: "test-placeholder-client-id",
    GOOGLE_CLIENT_SECRET: "test-placeholder-client-secret",
    ...overrides,
  });
}

describe("production Better Auth options (AC-36)", () => {
  const options = buildAuthOptions({ db: fakeDb, env: env() });

  it("enables only the Google social provider", () => {
    expect(Object.keys(options.socialProviders)).toEqual(["google"]);
  });

  it("disables email and password", () => {
    expect(options.emailAndPassword.enabled).toBe(false);
  });

  it("has no plugins (no test utilities in the production config)", () => {
    expect("plugins" in options).toBe(false);
  });

  it("disables the session cookie cache", () => {
    expect(options.session.cookieCache.enabled).toBe(false);
  });

  it("takes the Google hd option from ALLOWED_GOOGLE_HD", () => {
    expect(options.socialProviders.google.hd).toBe("allowed.test");
    const other = buildAuthOptions({ db: fakeDb, env: env({ ALLOWED_GOOGLE_HD: "another.test" }) });
    expect(other.socialProviders.google.hd).toBe("another.test");
  });

  it("RV-C-01: disables account linking", () => {
    expect(options.account.accountLinking.enabled).toBe(false);
  });

  it("RV-C-01: disables Google ID-token sign-in (authorization-code flow only)", () => {
    expect(options.socialProviders.google.disableIdTokenSignIn).toBe(true);
  });

  it("RV-C-01: disables the unused account and profile endpoints", () => {
    expect([...options.disabledPaths].sort()).toEqual(
      ["/account-info", "/get-access-token", "/link-social", "/refresh-token", "/unlink-account", "/update-user"].sort(),
    );
    expect([...AUTH_DISABLED_PATHS].sort()).toEqual([...options.disabledPaths].sort());
  });

  it("maps the hd claim onto the user without overriding getUserInfo", () => {
    expect("getUserInfo" in options.socialProviders.google).toBe(false);
    expect(options.socialProviders.google.mapProfileToUser({ hd: "Allowed.Test" } as never)).toEqual({
      googleHd: "allowed.test",
    });
    expect(options.socialProviders.google.mapProfileToUser({} as never)).toEqual({ googleHd: null });
  });
});

describe("auth init fails closed (R1.3)", () => {
  it.each(["BETTER_AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])(
    "throws AuthConfigError naming %s when it is missing, without echoing values",
    (name) => {
      const source = env({ [name]: "" });
      let caught: unknown;
      try {
        buildAuthOptions({ db: fakeDb, env: source });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AuthConfigError);
      const error = caught as AuthConfigError;
      expect(error.missing).toEqual([name]);
      expect(error.message).not.toContain("test-placeholder");
      if (source.BETTER_AUTH_SECRET) {
        expect(error.message).not.toContain(source.BETTER_AUTH_SECRET);
      }
    },
  );
});
