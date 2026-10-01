import { BlobNotFoundError, copy, del, get, head } from "@vercel/blob";
import { getUploadConfig, type UploadConfig } from "./config";

/**
 * Thin wrapper over the PRIVATE Vercel Blob store (T-15, T-16, DP4).
 *
 * - Every call passes the server-side token explicitly and `access: "private"`
 *   where the SDK needs it.
 * - Callers work with blob PATHNAMES only. The blob URLs returned by the SDK
 *   are never returned from here, so they cannot end up in HTML or JSON
 *   (AC-24).
 * - Integration tests replace `@vercel/blob` with `vi.mock` (SIMULATED). The
 *   real behaviour against a Blob store is verified manually (TC-43).
 */

export interface UploadedBlobInfo {
  pathname: string;
  size: number;
  contentType: string;
}

export interface UploadedBlobStream {
  stream: ReadableStream<Uint8Array>;
  size: number;
}

/** Metadata of an uploaded blob, or null when it does not exist. */
export async function headUploadedBlob(pathname: string, config: UploadConfig): Promise<UploadedBlobInfo | null> {
  try {
    const result = await head(pathname, { token: config.token });
    return { pathname: result.pathname, size: result.size, contentType: result.contentType };
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null;
    throw error;
  }
}

/** Content stream of a private blob, or null when it does not exist. */
export async function openUploadedBlob(pathname: string, config: UploadConfig): Promise<UploadedBlobStream | null> {
  const result = await get(pathname, { access: "private", token: config.token });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return { stream: result.stream, size: result.blob.size };
}

/**
 * Copy a private blob to a NEW pathname (Duplicate and Move, PRD §12 E8/E9).
 *
 * `toPathname` is the requested prefix + file name; Blob appends a random
 * suffix (`addRandomSuffix`) and overwriting is forbidden, so every attempt
 * produces fresh pathnames that belong only to that attempt. That is what
 * makes cleanup after a failure safe: the caller deletes exactly the
 * pathnames returned here, never anything that existed before.
 */
export async function copyUploadedBlob(
  fromPathname: string,
  toPathname: string,
  contentType: string,
  config: UploadConfig,
): Promise<string> {
  const result = await copy(fromPathname, toPathname, {
    access: "private",
    token: config.token,
    contentType,
    addRandomSuffix: true,
    allowOverwrite: false,
  });
  return result.pathname;
}

/**
 * Delete blobs after their rows are gone (attachment delete, page delete).
 * Best effort by design: the rows are already deleted, so a Blob failure (or
 * missing configuration) is logged server-side and never surfaced to the
 * user. A failure leaves an orphan blob that no route can serve, because
 * downloads always go through an attachment row (plan RK-5 accepts orphans).
 */
export async function deleteBlobsBestEffort(pathnames: readonly string[]): Promise<void> {
  if (pathnames.length === 0) return;
  try {
    const config = getUploadConfig();
    if (!config) {
      console.warn("[uploads] BLOB_READ_WRITE_TOKEN is not configured; blobs were not deleted", {
        count: pathnames.length,
      });
      return;
    }
    await del([...pathnames], { token: config.token });
  } catch (error) {
    console.error("[uploads] could not delete blobs", {
      pathnames,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}
