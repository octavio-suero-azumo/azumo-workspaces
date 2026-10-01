import { sanitizeDisplayName } from "@/lib/attachment-rules";

/**
 * Response headers for `GET /api/files/{id}` (T-16, AC-24, DP7).
 *
 * - `Content-Disposition: attachment` always (never inline), with the file
 *   name from `display_name` encoded per RFC 6266 / RFC 8187: an ASCII
 *   `filename="…"` fallback plus `filename*=UTF-8''…` for the real name.
 * - `Cache-Control: private, no-cache` (no shared caches; revalidate).
 * - `X-Content-Type-Options: nosniff`, and a sandboxing CSP as defense in
 *   depth in case a browser ever renders the response.
 * - `Content-Type` is the type validated against the P8 allowlist at
 *   registration; anything malformed falls back to `application/octet-stream`.
 */

const FALLBACK_FILENAME = "download";
const FILENAME_MAX = 200;

// RFC 6838 restricted-name chars, lowercase (the stored type is normalized).
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** Display name → safe file name: no control/bidi characters, no path separators, never empty. */
export function downloadFileName(displayName: unknown): string {
  const cleaned = Array.from(sanitizeDisplayName(displayName).replace(/[/\\]/g, "_"))
    .slice(0, FILENAME_MAX)
    .join("")
    .trim();
  return cleaned.length > 0 ? cleaned : FALLBACK_FILENAME;
}

/** RFC 8187 `value-chars`: percent-encode everything except attr-char. */
function encodeRfc8187(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** ASCII-only quoted-string fallback for old clients (`"` and `\` and non-ASCII replaced). */
function asciiFallback(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .trim();
  return ascii.length > 0 ? ascii : FALLBACK_FILENAME;
}

/** `attachment; filename="<ascii>"; filename*=UTF-8''<pct-encoded>` */
export function contentDispositionAttachment(displayName: unknown): string {
  const name = downloadFileName(displayName);
  return `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeRfc8187(name)}`;
}

export function safeContentType(value: unknown): string {
  return typeof value === "string" && MIME_RE.test(value) ? value : "application/octet-stream";
}

export function downloadHeaders(file: { displayName: string; contentType: string; size?: number | null }): Headers {
  const headers = new Headers({
    "Content-Type": safeContentType(file.contentType),
    "Content-Disposition": contentDispositionAttachment(file.displayName),
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  if (typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0) {
    headers.set("Content-Length", String(file.size));
  }
  return headers;
}
