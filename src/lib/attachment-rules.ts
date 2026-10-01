/**
 * Attachment rules shared by the DB schema, the server and the upload UI
 * (T-13, T-15, T-16; R4.2, P2 = uploads, P8).
 *
 * Pure functions and constants only: no I/O, no server imports, and no `@/`
 * alias imports (the Drizzle schema imports this file through a relative path
 * when drizzle-kit loads it).
 *
 * Pathname layout (architecture §7, RV-08):
 *
 *   ws/{workspaceId}/pg/{pageId}/{file}
 *
 * The client proposes the pathname; the server never rewrites it (the Blob
 * SDK signs the client's pathname into the token), so the server VALIDATES it
 * against the page it authorized: the prefix must be exactly
 * `ws/{workspaceId}/pg/{pageId}/` and `{file}` must be a single safe segment.
 */

/** Allowed `attachment.kind` values (P2 = uploads only; links are out of scope). Drives the DB CHECK. */
export const ATTACHMENT_KINDS = ["upload"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Maximum display name length, in Unicode code points (DB CHECK uses the same value). */
export const ATTACHMENT_DISPLAY_NAME_MAX = 255;

/** Maximum length of the `{file}` segment of an upload pathname (includes Blob's random suffix). */
export const UPLOAD_FILE_SEGMENT_MAX = 200;

/** Longest pathname the server will look at (prefix is ~84 chars with two UUIDs). */
export const UPLOAD_PATHNAME_MAX = 320;

/** Longest file stem the client puts in a pathname (Blob then appends `-<random>`). */
const FILE_STEM_MAX = 80;
const FILE_EXTENSION_MAX = 10;

/** Message shown by the UI and returned by the server when no Blob token is configured. */
export const UPLOADS_NOT_CONFIGURED_MESSAGE = "Uploads are not configured on this server.";

/** Upload endpoints (the only URLs the browser ever sees for files). */
export const UPLOAD_TOKEN_ROUTE = "/api/uploads";
export const fileDownloadPath = (attachmentId: string) => `/api/files/${encodeURIComponent(attachmentId)}`;

/** `ws/{workspaceId}/pg/{pageId}/` */
export function uploadPathPrefix(workspaceId: string, pageId: string): string {
  return `ws/${workspaceId}/pg/${pageId}/`;
}

// One path segment: starts with a letter or digit, then letters, digits, '.', '_' or '-'.
const FILE_SEGMENT_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${UPLOAD_FILE_SEGMENT_MAX - 1}}$`);

/** True when `segment` is a single safe file name (no slashes, no `..`, no control characters). */
export function isValidUploadFileSegment(segment: string): boolean {
  return FILE_SEGMENT_RE.test(segment) && !segment.includes("..");
}

/**
 * Turn a user's file name into a safe pathname segment: ASCII letters, digits,
 * '_' and '-' in the stem, a short alphanumeric extension. Never empty.
 */
export function toUploadFileSegment(fileName: string): string {
  const name = typeof fileName === "string" ? fileName : "";
  const lastDot = name.lastIndexOf(".");
  const rawStem = lastDot > 0 ? name.slice(0, lastDot) : name;
  const rawExtension = lastDot > 0 ? name.slice(lastDot + 1) : "";

  const stem =
    rawStem
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .slice(0, FILE_STEM_MAX)
      .replace(/[-_]+$/g, "") || "file";
  const extension = rawExtension.replace(/[^A-Za-z0-9]/g, "").slice(0, FILE_EXTENSION_MAX).toLowerCase();
  return extension ? `${stem}.${extension}` : stem;
}

/** The pathname the client asks the token route for. */
export function buildUploadPathname(workspaceId: string, pageId: string, fileName: string): string {
  return `${uploadPathPrefix(workspaceId, pageId)}${toUploadFileSegment(fileName)}`;
}

/** `Text/Plain; charset=UTF-8` → `text/plain`. Returns "" for anything that is not a string. */
export function normalizeContentType(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.split(";")[0].trim().toLowerCase();
}

/** Whether `contentType` (normalized first) is in the configured allowlist (P8). */
export function isAllowedContentType(contentType: unknown, allowedTypes: readonly string[]): boolean {
  const normalized = normalizeContentType(contentType);
  return normalized.length > 0 && allowedTypes.includes(normalized);
}

// C0/C1 control characters, and bidi overrides/isolates that can disguise a
// file name (e.g. "invoice‮fdp.exe").
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** Tabs/newlines become spaces, other unsafe characters are removed, whitespace collapses, trim. May return "". */
export function sanitizeDisplayName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFC")
    .replace(/[\t\n\v\f\r]/g, " ")
    .replace(UNSAFE_NAME_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Length in Unicode code points (matches Postgres `char_length`). */
export const codePointLength = (value: string) => Array.from(value).length;

export interface UploadLimits {
  maxBytes: number;
  allowedTypes: readonly string[];
}

export const FILE_TYPE_NOT_ALLOWED_MESSAGE = "This file type is not allowed.";
export const fileTooLargeMessage = (maxBytes: number) => `This file is too large. The maximum size is ${formatBytes(maxBytes)}.`;

/**
 * Why a file (size + content type) would be rejected under `limits`, or null
 * when it is acceptable. The same rule runs in the browser (convenience only),
 * at token issuance and at registration (enforcement).
 */
export function uploadProblem(file: { size: unknown; contentType: unknown }, limits: UploadLimits): string | null {
  if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) {
    return "Invalid file size.";
  }
  if (file.size > limits.maxBytes) {
    return fileTooLargeMessage(limits.maxBytes);
  }
  if (!isAllowedContentType(file.contentType, limits.allowedTypes)) {
    return FILE_TYPE_NOT_ALLOWED_MESSAGE;
  }
  return null;
}

/** Human-readable size: "512 B", "1.5 KB", "10 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
