import { afterEach, describe, expect, it, vi } from "vitest";
import { UPLOADS_NOT_CONFIGURED_MESSAGE } from "@/lib/attachment-rules";
import { DEFAULT_UPLOAD_ALLOWED_TYPES, DEFAULT_UPLOAD_MAX_BYTES, parseEnv } from "@/server/env";
import { isBlobReadWriteToken, uploadConfigFrom } from "@/server/uploads/config";

// T-15: uploads fail closed without a Blob read-write token (P4 pending), and
// the P8 limits always come from env.ts. Fake token values only.

const FAKE_TOKEN = "vercel_blob_rw_simulatedstore_NOT-A-REAL-TOKEN";
const base = { ALLOWED_GOOGLE_HD: "allowed.test" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("isBlobReadWriteToken", () => {
  it.each([
    [FAKE_TOKEN, true],
    ["vercel_blob_rw_store_secret_with_underscores", true],
    ["", false],
    ["not-a-token", false],
    ["vercel_blob_rw__secret", false],
    ["vercel_blob_rw_store_", false],
    ["vercel_blob_client_store_x", false],
    [undefined, false],
  ])("%j → %s", (value, expected) => {
    expect(isBlobReadWriteToken(value)).toBe(expected);
  });
});

describe("uploadConfigFrom", () => {
  it("is null (not configured) without BLOB_READ_WRITE_TOKEN, including an empty value", () => {
    expect(uploadConfigFrom(parseEnv(base))).toBeNull();
    expect(uploadConfigFrom(parseEnv({ ...base, BLOB_READ_WRITE_TOKEN: "" }))).toBeNull();
  });

  it("is null for a value that is not a Blob read-write token", () => {
    expect(uploadConfigFrom(parseEnv({ ...base, BLOB_READ_WRITE_TOKEN: "abc" }))).toBeNull();
  });

  it("uses the approved P8 defaults when only the token is set", () => {
    expect(uploadConfigFrom(parseEnv({ ...base, BLOB_READ_WRITE_TOKEN: FAKE_TOKEN }))).toEqual({
      token: FAKE_TOKEN,
      maxBytes: DEFAULT_UPLOAD_MAX_BYTES,
      allowedTypes: DEFAULT_UPLOAD_ALLOWED_TYPES,
    });
    expect(DEFAULT_UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it("uses UPLOAD_MAX_BYTES / UPLOAD_ALLOWED_TYPES when set", () => {
    const config = uploadConfigFrom(
      parseEnv({ ...base, BLOB_READ_WRITE_TOKEN: FAKE_TOKEN, UPLOAD_MAX_BYTES: "1024", UPLOAD_ALLOWED_TYPES: "text/plain, image/png" }),
    );
    expect(config).toMatchObject({ maxBytes: 1024, allowedTypes: ["text/plain", "image/png"] });
  });
});

describe("process-level accessors", () => {
  it("requireUploadConfig throws a 503 'not configured' error without a token; settings report disabled", async () => {
    vi.stubEnv("ALLOWED_GOOGLE_HD", "allowed.test");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("DATABASE_URL", "");
    const { requireUploadConfig, getUploadSettings } = await import("@/server/uploads/config");
    const { statusForError } = await import("@/server/http");

    const error = (() => {
      try {
        requireUploadConfig();
      } catch (e) {
        return e;
      }
      throw new Error("expected requireUploadConfig to throw");
    })();
    expect(error).toMatchObject({ name: "ServiceUnavailableError", code: "UNAVAILABLE", message: UPLOADS_NOT_CONFIGURED_MESSAGE });
    expect(statusForError(error)).toBe(503);
    expect(getUploadSettings()).toEqual({
      enabled: false,
      maxBytes: DEFAULT_UPLOAD_MAX_BYTES,
      allowedTypes: DEFAULT_UPLOAD_ALLOWED_TYPES,
    });
  });

  it("settings never include the token", async () => {
    vi.stubEnv("ALLOWED_GOOGLE_HD", "allowed.test");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", FAKE_TOKEN);
    vi.stubEnv("DATABASE_URL", "");
    const { getUploadSettings } = await import("@/server/uploads/config");
    const settings = getUploadSettings();
    expect(settings.enabled).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(FAKE_TOKEN);
  });
});
