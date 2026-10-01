import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPLOAD_ALLOWED_TYPES,
  DEFAULT_UPLOAD_MAX_BYTES,
  EnvValidationError,
  parseEnv,
  type EnvSource,
} from "@/server/env";

// TC-05 (b) / AC-06: env validation fails closed. Placeholder domain only.
const VALID_HD = "allowed.test";

function envWith(overrides: EnvSource): EnvSource {
  return { ALLOWED_GOOGLE_HD: VALID_HD, ...overrides };
}

function expectInvalid(source: EnvSource, variable: string): EnvValidationError {
  let caught: unknown;
  try {
    parseEnv(source);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EnvValidationError);
  const error = caught as EnvValidationError;
  expect(error.issues.some((issue) => issue.startsWith(`${variable}:`))).toBe(true);
  return error;
}

describe("ALLOWED_GOOGLE_HD (fail closed)", () => {
  it("rejects when unset", () => {
    expectInvalid({}, "ALLOWED_GOOGLE_HD");
  });

  it("rejects when empty", () => {
    expectInvalid({ ALLOWED_GOOGLE_HD: "" }, "ALLOWED_GOOGLE_HD");
  });

  it("rejects '*'", () => {
    expectInvalid({ ALLOWED_GOOGLE_HD: "*" }, "ALLOWED_GOOGLE_HD");
  });

  it.each(["*.allowed.test", "allowed.*", "*allowed.test"])("rejects wildcard %s", (value) => {
    expectInvalid({ ALLOWED_GOOGLE_HD: value }, "ALLOWED_GOOGLE_HD");
  });

  it.each(["allowed.test,other.test", "allowed.test, other.test", "allowed.test,"])(
    "rejects comma list %s",
    (value) => {
      expectInvalid({ ALLOWED_GOOGLE_HD: value }, "ALLOWED_GOOGLE_HD");
    },
  );

  it.each(["allowed.test other.test", " allowed.test", "allowed.test\n", "\t"])(
    "rejects whitespace %j",
    (value) => {
      expectInvalid({ ALLOWED_GOOGLE_HD: value }, "ALLOWED_GOOGLE_HD");
    },
  );

  it.each(["Allowed.test", "ALLOWED.TEST"])("rejects uppercase %s", (value) => {
    expectInvalid({ ALLOWED_GOOGLE_HD: value }, "ALLOWED_GOOGLE_HD");
  });

  it.each([
    "localhost",
    "allowed",
    "-allowed.test",
    "allowed-.test",
    "allowed..test",
    ".allowed.test",
    "allowed.test.",
    "https://allowed.test",
    "user@allowed.test",
    "allowed.test/path",
    `${"a".repeat(64)}.test`,
  ])("rejects non-hostname %s", (value) => {
    expectInvalid({ ALLOWED_GOOGLE_HD: value }, "ALLOWED_GOOGLE_HD");
  });

  it.each(["allowed.test", "sub.allowed.test", "my-org.example", "a1.b2.test"])(
    "accepts valid lowercase hostname %s",
    (value) => {
      expect(parseEnv({ ALLOWED_GOOGLE_HD: value }).ALLOWED_GOOGLE_HD).toBe(value);
    },
  );

  it("does not echo the invalid value in the error message", () => {
    const secretish = "SeCrEt-Value.test";
    const error = expectInvalid({ ALLOWED_GOOGLE_HD: secretish }, "ALLOWED_GOOGLE_HD");
    expect(error.message).not.toContain(secretish);
  });
});

describe("upload limits (P8)", () => {
  it("defaults UPLOAD_MAX_BYTES to 10 MB when unset or empty", () => {
    expect(DEFAULT_UPLOAD_MAX_BYTES).toBe(10485760);
    expect(parseEnv(envWith({})).UPLOAD_MAX_BYTES).toBe(10485760);
    expect(parseEnv(envWith({ UPLOAD_MAX_BYTES: "" })).UPLOAD_MAX_BYTES).toBe(10485760);
  });

  it("parses a positive integer UPLOAD_MAX_BYTES", () => {
    expect(parseEnv(envWith({ UPLOAD_MAX_BYTES: "2048" })).UPLOAD_MAX_BYTES).toBe(2048);
  });

  it.each(["0", "-1", "1.5", "10MB", "abc", " 100", "1e6", "99999999999999999999"])(
    "rejects invalid UPLOAD_MAX_BYTES %j",
    (value) => {
      expectInvalid(envWith({ UPLOAD_MAX_BYTES: value }), "UPLOAD_MAX_BYTES");
    },
  );

  it("defaults UPLOAD_ALLOWED_TYPES to the approved list", () => {
    const env = parseEnv(envWith({}));
    expect(env.UPLOAD_ALLOWED_TYPES).toEqual(DEFAULT_UPLOAD_ALLOWED_TYPES);
    expect([...env.UPLOAD_ALLOWED_TYPES].sort()).toEqual(
      [
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "text/plain",
        "text/csv",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ].sort(),
    );
  });

  it("parses, trims, lowercases and de-duplicates a custom list", () => {
    const env = parseEnv(
      envWith({ UPLOAD_ALLOWED_TYPES: " application/pdf, IMAGE/PNG ,image/png" }),
    );
    expect(env.UPLOAD_ALLOWED_TYPES).toEqual(["application/pdf", "image/png"]);
  });

  it.each(["*/*", "image/*", "application/pdf,image/*", "notamime", ",", " , "])(
    "rejects invalid UPLOAD_ALLOWED_TYPES %j",
    (value) => {
      expectInvalid(envWith({ UPLOAD_ALLOWED_TYPES: value }), "UPLOAD_ALLOWED_TYPES");
    },
  );
});

describe("other variables", () => {
  it("treats empty DATABASE_URL as unset (local PGlite)", () => {
    expect(parseEnv(envWith({ DATABASE_URL: "" })).DATABASE_URL).toBeUndefined();
  });

  it("accepts postgres URLs and rejects other schemes", () => {
    expect(parseEnv(envWith({ DATABASE_URL: "postgres://db.test:5432/app" })).DATABASE_URL).toBe(
      "postgres://db.test:5432/app",
    );
    expect(parseEnv(envWith({ DATABASE_URL: "postgresql://db.test/app" })).DATABASE_URL).toBe(
      "postgresql://db.test/app",
    );
    expectInvalid(envWith({ DATABASE_URL: "mysql://db.test/app" }), "DATABASE_URL");
  });

  it("keeps VERCEL (set by Vercel in every environment) as an optional string", () => {
    expect(parseEnv(envWith({})).VERCEL).toBeUndefined();
    expect(parseEnv(envWith({ VERCEL: "" })).VERCEL).toBeUndefined();
    expect(parseEnv(envWith({ VERCEL: "1" })).VERCEL).toBe("1");
  });

  it("parses ENABLE_TEST_AUTH as a boolean", () => {
    expect(parseEnv(envWith({})).ENABLE_TEST_AUTH).toBe(false);
    expect(parseEnv(envWith({ ENABLE_TEST_AUTH: "1" })).ENABLE_TEST_AUTH).toBe(true);
    expect(parseEnv(envWith({ ENABLE_TEST_AUTH: "false" })).ENABLE_TEST_AUTH).toBe(false);
    expectInvalid(envWith({ ENABLE_TEST_AUTH: "yes" }), "ENABLE_TEST_AUTH");
  });

  it("refuses ENABLE_TEST_AUTH when VERCEL_ENV=production", () => {
    expectInvalid(
      envWith({ VERCEL_ENV: "production", ENABLE_TEST_AUTH: "1" }),
      "ENABLE_TEST_AUTH",
    );
    // BETTER_AUTH_URL is required in production since RV-C-07.
    expect(
      parseEnv(envWith({ VERCEL_ENV: "production", BETTER_AUTH_URL: "https://app.example.test" })).ENABLE_TEST_AUTH,
    ).toBe(false);
  });

  describe("BETTER_AUTH_URL (review RV-C-07)", () => {
    it.each([["unset", undefined], ["empty", ""]])("is required when VERCEL_ENV=production (%s)", (_label, value) => {
      expectInvalid(envWith({ VERCEL_ENV: "production", BETTER_AUTH_URL: value }), "BETTER_AUTH_URL");
    });

    it.each(["not a url", "app.example.test", "ftp://app.example.test", "javascript:alert(1)"])(
      "must be an absolute URL in production: %j",
      (value) => {
        expectInvalid(envWith({ VERCEL_ENV: "production", BETTER_AUTH_URL: value }), "BETTER_AUTH_URL");
      },
    );

    // Review RV-F-07: plain http is refused in production.
    it.each(["http://app.example.test", "http://127.0.0.1:3000", "HTTP://app.example.test"])(
      "must use https in production: %j",
      (value) => {
        const error = expectInvalid(envWith({ VERCEL_ENV: "production", BETTER_AUTH_URL: value }), "BETTER_AUTH_URL");
        expect(error.issues).toContain("BETTER_AUTH_URL: must be an absolute https:// URL when VERCEL_ENV=production");
      },
    );

    it.each([["preview", "preview"], ["local (unset VERCEL_ENV)", undefined]])(
      "still accepts http outside production (%s), e.g. local E2E",
      (_label, vercelEnv) => {
        expect(
          parseEnv(envWith({ VERCEL_ENV: vercelEnv, BETTER_AUTH_URL: "http://127.0.0.1:3100" })).BETTER_AUTH_URL,
        ).toBe("http://127.0.0.1:3100");
      },
    );

    it("accepts an https URL in production", () => {
      expect(
        parseEnv(envWith({ VERCEL_ENV: "production", BETTER_AUTH_URL: "https://app.example.test" })).BETTER_AUTH_URL,
      ).toBe("https://app.example.test");
    });

    it.each([["local (unset VERCEL_ENV)", undefined], ["preview", "preview"], ["development", "development"]])(
      "stays optional outside production: %s",
      (_label, vercelEnv) => {
        expect(parseEnv(envWith({ VERCEL_ENV: vercelEnv })).BETTER_AUTH_URL).toBeUndefined();
      },
    );

    it("does not echo the invalid value", () => {
      const error = expectInvalid(
        envWith({ VERCEL_ENV: "production", BETTER_AUTH_URL: "not-a-url-SECRETISH" }),
        "BETTER_AUTH_URL",
      );
      expect(error.message).not.toContain("SECRETISH");
    });
  });

  it("does not echo secret values when reporting other errors", () => {
    const secret = "super-secret-token-value";
    const error = expectInvalid(
      { BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_SECRET: secret },
      "ALLOWED_GOOGLE_HD",
    );
    expect(error.message).not.toContain(secret);
  });
});
