/**
 * SIMULATED Vercel Blob for integration tests (increment E).
 *
 * There is no real Blob store or token yet (depends on P4). Tests replace the
 * SERVER SDK (`@vercel/blob`: head/get/del) with `vi.mock` and use the helpers
 * below to build its return values. The client-token signing in
 * `@vercel/blob/client` (`handleUpload`) is the REAL SDK code: it is a local
 * HMAC over the fake token below and makes no network call (tests assert that
 * `fetch` is never called).
 *
 * What this proves: our authorization, pathname validation, P8 checks, row
 * writes, headers and which SDK calls we make with which arguments.
 * What it does NOT prove: that the real Blob service accepts these calls,
 * enforces the token constraints, or deletes the blob. That is TC-43
 * (manual, with a real private store).
 */
import type { GetBlobResult, HeadBlobResult } from "@vercel/blob";

/** Obviously fake read-write token (format `vercel_blob_rw_<storeId>_<secret>`). Not a secret. */
export const SIMULATED_BLOB_TOKEN = "vercel_blob_rw_simulatedstore_NOT-A-REAL-TOKEN";

/** Host a real private blob URL would have; must never appear in our HTML/JSON. */
export const SIMULATED_BLOB_HOST = "simulatedstore.private.blob.vercel-storage.com";

export const simulatedBlobUrl = (pathname: string) => `https://${SIMULATED_BLOB_HOST}/${pathname}`;

/** What `head()` resolves to for an existing blob. */
export function simulatedHead(pathname: string, overrides: Partial<HeadBlobResult> = {}): HeadBlobResult {
  const url = simulatedBlobUrl(pathname);
  return {
    url,
    downloadUrl: `${url}?download=1`,
    pathname,
    size: 1234,
    contentType: "application/pdf",
    contentDisposition: 'attachment; filename="x"',
    cacheControl: "public, max-age=2592000",
    uploadedAt: new Date("2026-09-30T10:00:00Z"),
    etag: '"simulated-etag"',
    ...overrides,
  };
}

/** What `get()` resolves to for an existing private blob (200 with a stream). */
export function simulatedGet(pathname: string, body: string, contentType = "application/pdf"): GetBlobResult {
  const bytes = new TextEncoder().encode(body);
  const url = simulatedBlobUrl(pathname);
  // `GetBlobResult.headers` is typed with undici's Headers; the global one is
  // equivalent at runtime.
  return {
    statusCode: 200 as const,
    stream: new Blob([bytes]).stream(),
    headers: new Headers({ "content-type": contentType, "x-simulated-url": url }),
    blob: {
      url,
      downloadUrl: `${url}?download=1`,
      pathname,
      contentDisposition: 'attachment; filename="x"',
      cacheControl: "private",
      uploadedAt: new Date("2026-09-30T10:00:00Z"),
      etag: '"simulated-etag"',
      contentType,
      size: bytes.byteLength,
    },
  } as unknown as GetBlobResult;
}
