import { UPLOADS_NOT_CONFIGURED_MESSAGE, type UploadLimits } from "@/lib/attachment-rules";
import { getEnv, type Env } from "@/server/env";
import { ServiceUnavailableError } from "@/server/errors";

/**
 * Upload configuration (T-15, P8, P4).
 *
 * Uploads go to a PRIVATE Vercel Blob store authorized by
 * `BLOB_READ_WRITE_TOKEN`. That token depends on P4 (Vercel account), so the
 * app must run without it: when it is missing (or not a Blob read-write
 * token), uploads are "not configured" and every upload/download entry point
 * fails closed with `ServiceUnavailableError` (503) and a clear message. The
 * rest of the app keeps working.
 *
 * Limits (P8) always come from `env.ts` (`UPLOAD_MAX_BYTES`,
 * `UPLOAD_ALLOWED_TYPES`, with the approved defaults). The token itself never
 * leaves the server.
 */

export interface UploadConfig extends UploadLimits {
  /** Blob read-write token. Server-only; never sent to a client. */
  readonly token: string;
}

/** What the UI needs (no token). */
export interface UploadSettings extends UploadLimits {
  enabled: boolean;
}

type UploadEnv = Pick<Env, "BLOB_READ_WRITE_TOKEN" | "UPLOAD_MAX_BYTES" | "UPLOAD_ALLOWED_TYPES">;

/** `vercel_blob_rw_<storeId>_<secret>`: the format the Blob SDK parses. */
export function isBlobReadWriteToken(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("vercel_blob_rw_")) return false;
  const [, , , storeId = "", ...secret] = value.split("_");
  return storeId.length > 0 && secret.join("_").length > 0;
}

export function uploadLimitsFrom(env: UploadEnv): UploadLimits {
  return { maxBytes: env.UPLOAD_MAX_BYTES, allowedTypes: env.UPLOAD_ALLOWED_TYPES };
}

/** Upload config from a validated env, or null when uploads are not configured. */
export function uploadConfigFrom(env: UploadEnv): UploadConfig | null {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!isBlobReadWriteToken(token)) return null;
  return { token, ...uploadLimitsFrom(env) };
}

/** Current config, or null when uploads are not configured. */
export function getUploadConfig(): UploadConfig | null {
  return uploadConfigFrom(getEnv());
}

/** Current limits (available even when uploads are not configured). */
export function getUploadLimits(): UploadLimits {
  return uploadLimitsFrom(getEnv());
}

/** Current config; throws `ServiceUnavailableError` (503) when uploads are not configured. */
export function requireUploadConfig(): UploadConfig {
  const config = getUploadConfig();
  if (!config) {
    throw new ServiceUnavailableError(UPLOADS_NOT_CONFIGURED_MESSAGE);
  }
  return config;
}

/** Settings for the upload UI: whether uploads work, and the limits to pre-check in the browser. */
export function getUploadSettings(): UploadSettings {
  const env = getEnv();
  return { enabled: uploadConfigFrom(env) !== null, ...uploadLimitsFrom(env) };
}
