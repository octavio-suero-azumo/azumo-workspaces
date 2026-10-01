import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  ATTACHMENT_DISPLAY_NAME_MAX,
  codePointLength,
  isValidUploadFileSegment,
  normalizeContentType,
  sanitizeDisplayName,
  UPLOAD_PATHNAME_MAX,
  uploadPathPrefix,
  uploadProblem,
  type AttachmentKind,
  type UploadLimits,
} from "@/lib/attachment-rules";
import { authorize } from "@/server/authz/authorize";
import { attachment, page } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { deleteBlobsBestEffort, headUploadedBlob } from "@/server/uploads/blob-store";
import { requireUploadConfig } from "@/server/uploads/config";
import type { DataContext } from "./context";

/**
 * Attachments (T-13 list, T-15 upload token + registration, T-16 download and
 * delete; R4.2–R4.4, P2 = uploads, P8, DP4, DP7, AC-22..AC-26, AC-38).
 *
 * Authorization (architecture §5): every member may list and download
 * (`page.view`); Owner and Editor may add (`attachment.add`) and delete
 * (`attachment.delete`). Non-member → NotFound (404), member without
 * permission → Forbidden (403). The workspace always comes from the page or
 * attachment row, never from client input (AC-38).
 *
 * Upload flow (architecture §7):
 * 1. `authorizeUploadRequest` runs inside the token route's
 *    `onBeforeGenerateToken`: authorize the page, VALIDATE the client's
 *    pathname (`ws/{workspaceId}/pg/{pageId}/{file}`; the SDK does not let the
 *    server rewrite it, RV-08) and the declared size/type (P8).
 * 2. The browser uploads straight to the private Blob store.
 * 3. `registerUpload` re-authorizes, re-validates the pathname against the
 *    authorized page, reads the stored blob's metadata with `head()`, deletes
 *    the blob if it breaks P8, and inserts the row. The SIZE from `head()` is
 *    the real stored size. The CONTENT TYPE is the one the client declared at
 *    upload time (Blob does not inspect the bytes), so the allow-list check on
 *    it limits labels, not content. That residual risk is mitigated at
 *    download: `Content-Disposition: attachment`, `nosniff` and a sandboxing
 *    CSP (see `src/server/uploads/download-headers.ts`). Review RV-F-08.
 *
 * Blob URLs never leave the server: rows store the pathname, views expose
 * only id/name/type/size (AC-24).
 */

export interface AttachmentView {
  id: string;
  displayName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface RegisteredAttachment extends AttachmentView {
  pageId: string;
  workspaceId: string;
}

/** Server-only: includes the blob pathname for the download route. */
export interface AttachmentDownload {
  id: string;
  pageId: string;
  workspaceId: string;
  displayName: string;
  contentType: string;
  sizeBytes: number;
  blobPathname: string;
}

export const INVALID_UPLOAD_REQUEST_MESSAGE = "Invalid upload request.";
export const PATHNAME_NOT_ALLOWED_MESSAGE = "The upload path does not belong to this page.";
export const INVALID_PATHNAME_MESSAGE = "Invalid upload path.";
export const UPLOAD_NOT_FOUND_MESSAGE = "The uploaded file was not found. Please upload it again.";
export const ALREADY_ATTACHED_MESSAGE = "This file is already attached.";
export const DISPLAY_NAME_REQUIRED_MESSAGE = "File name is required.";
export const DISPLAY_NAME_TOO_LONG_MESSAGE = `File name must be at most ${ATTACHMENT_DISPLAY_NAME_MAX} characters.`;

const UPLOAD_KIND: AttachmentKind = "upload";

const idField = z.string({ error: "Invalid input." });

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, message?: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(message ?? result.error.issues[0]?.message ?? "Invalid input.");
  }
  return result.data;
}

/** Read one field of an untrusted input object (undefined when absent or not an object). */
function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && Object.hasOwn(input, key)
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The client's pathname must be `ws/{workspaceId}/pg/{pageId}/{file}` for the
 * AUTHORIZED page. A different prefix (another page or workspace) is
 * Forbidden; a malformed file segment is a validation error.
 */
export function assertUploadPathname(pathname: unknown, workspaceId: string, pageId: string): string {
  if (typeof pathname !== "string" || pathname.length === 0 || pathname.length > UPLOAD_PATHNAME_MAX) {
    throw new ValidationError(INVALID_PATHNAME_MESSAGE);
  }
  const prefix = uploadPathPrefix(workspaceId, pageId);
  if (!pathname.startsWith(prefix)) {
    throw new ForbiddenError(PATHNAME_NOT_ALLOWED_MESSAGE);
  }
  if (!isValidUploadFileSegment(pathname.slice(prefix.length))) {
    throw new ValidationError(INVALID_PATHNAME_MESSAGE);
  }
  return pathname;
}

/** Sanitize (control/bidi characters removed), then require 1–255 code points. */
export function parseDisplayName(raw: unknown): string {
  const name = sanitizeDisplayName(raw);
  if (name.length === 0) {
    throw new ValidationError(DISPLAY_NAME_REQUIRED_MESSAGE);
  }
  if (codePointLength(name) > ATTACHMENT_DISPLAY_NAME_MAX) {
    throw new ValidationError(DISPLAY_NAME_TOO_LONG_MESSAGE);
  }
  return name;
}

/** `clientPayload` of the token request: a JSON object string `{ pageId, size, contentType }`. */
function parseClientPayload(clientPayload: unknown): Record<string, unknown> {
  if (typeof clientPayload !== "string" || clientPayload.length === 0 || clientPayload.length > 4096) {
    throw new ValidationError(INVALID_UPLOAD_REQUEST_MESSAGE);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(clientPayload);
  } catch {
    throw new ValidationError(INVALID_UPLOAD_REQUEST_MESSAGE);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(INVALID_UPLOAD_REQUEST_MESSAGE);
  }
  return parsed as Record<string, unknown>;
}

const declaredFile = z.object({
  size: z.number().int().nonnegative(),
  contentType: z.string().max(255),
});

const viewColumns = {
  id: attachment.id,
  displayName: attachment.displayName,
  contentType: attachment.contentType,
  sizeBytes: attachment.sizeBytes,
  createdAt: attachment.createdAt,
};

/** Attachments of a page, for any member of its workspace (AC-20). Oldest first. */
export async function listAttachments(ctx: DataContext, input: { pageId: string }): Promise<AttachmentView[]> {
  const { pageId } = parseOrThrow(z.object({ pageId: idField }), input);
  const authorized = await authorize(ctx, { pageId }, "page.view");
  return ctx.db
    .select(viewColumns)
    .from(attachment)
    .where(and(eq(attachment.pageId, authorized.resource.id), eq(attachment.workspaceId, authorized.workspaceId)))
    .orderBy(asc(attachment.createdAt), asc(attachment.id));
}

/**
 * Gate for the upload token route (AC-22, AC-23, AC-38). Input: the pathname
 * the client asked for and its `clientPayload` (`{ pageId, size, contentType }`).
 * Returns the authorized page and workspace. Order: authorization first (so a
 * non-member always gets 404), then pathname, then declared size/type.
 */
export async function authorizeUploadRequest(
  ctx: DataContext,
  input: { pathname: unknown; clientPayload: unknown },
  limits: UploadLimits,
): Promise<{ workspaceId: string; pageId: string }> {
  const payload = parseClientPayload(input.clientPayload);
  const { pageId } = parseOrThrow(z.object({ pageId: idField }), payload, INVALID_UPLOAD_REQUEST_MESSAGE);
  const authorized = await authorize(ctx, { pageId }, "attachment.add");
  assertUploadPathname(input.pathname, authorized.workspaceId, authorized.resource.id);

  const declared = parseOrThrow(declaredFile, payload, INVALID_UPLOAD_REQUEST_MESSAGE);
  const problem = uploadProblem(declared, limits);
  if (problem) {
    throw new ValidationError(problem);
  }
  return { workspaceId: authorized.workspaceId, pageId: authorized.resource.id };
}

function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === "23503") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Register an uploaded blob as an attachment (Owner, Editor). Input:
 * `{ pageId, pathname, displayName }`, where `pathname` is the one returned by
 * the client upload (with Blob's random suffix).
 *
 * Nothing is written unless: the requester may add attachments to the page,
 * the pathname is under THAT page's prefix, uploads are configured, the blob
 * exists, and its stored size and (client-declared) content type satisfy P8
 * (otherwise the blob is deleted).
 */
export async function registerUpload(ctx: DataContext, input: unknown): Promise<RegisteredAttachment> {
  const { pageId } = parseOrThrow(z.object({ pageId: idField }), input);
  const authorized = await authorize(ctx, { pageId }, "attachment.add");
  const workspaceId = authorized.workspaceId;
  const authorizedPageId = authorized.resource.id;
  const pathname = assertUploadPathname(field(input, "pathname"), workspaceId, authorizedPageId);
  const displayName = parseDisplayName(field(input, "displayName"));

  const config = requireUploadConfig();
  const blob = await headUploadedBlob(pathname, config);
  if (!blob || blob.pathname !== pathname) {
    throw new ValidationError(UPLOAD_NOT_FOUND_MESSAGE);
  }
  const contentType = normalizeContentType(blob.contentType);
  const problem = uploadProblem({ size: blob.size, contentType }, config);
  if (problem) {
    await deleteBlobsBestEffort([pathname]);
    throw new ValidationError(problem);
  }

  let inserted: AttachmentView | undefined;
  let pageGone = false;
  try {
    inserted = await ctx.db.transaction(async (tx) => {
      // The page must still be live in the authorized workspace. FOR SHARE
      // blocks a concurrent Trash/Move of this page row until the row is in,
      // so an attachment can never land on a trashed or moved page (AC-56).
      const [live] = await tx
        .select({ id: page.id })
        .from(page)
        .where(and(eq(page.id, authorizedPageId), eq(page.workspaceId, workspaceId), isNull(page.deletedAt)))
        .for("share");
      if (!live) {
        pageGone = true;
        return undefined;
      }
      const [row] = await tx
        .insert(attachment)
        .values({
          pageId: authorizedPageId,
          workspaceId,
          kind: UPLOAD_KIND,
          displayName,
          blobPathname: pathname,
          contentType,
          sizeBytes: blob.size,
          createdBy: ctx.userId,
        })
        .onConflictDoNothing({ target: attachment.blobPathname })
        .returning(viewColumns);
      return row;
    });
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      // The page left this workspace after authorize(): nothing to attach it to.
      pageGone = true;
    } else {
      throw error;
    }
  }
  if (pageGone) {
    await deleteBlobsBestEffort([pathname]);
    throw new NotFoundError();
  }
  if (!inserted) {
    // Already registered (the existing row owns the blob; keep it).
    throw new ConflictError(ALREADY_ATTACHED_MESSAGE);
  }
  return { ...inserted, pageId: authorizedPageId, workspaceId };
}

/** Download gate (`page.view`, every member). Server-only result: includes the blob pathname. */
export async function getAttachmentDownload(ctx: DataContext, input: { attachmentId: string }): Promise<AttachmentDownload> {
  const { attachmentId } = parseOrThrow(z.object({ attachmentId: idField }), input);
  const { resource } = await authorize(ctx, { attachmentId }, "page.view");
  return { ...resource };
}

/**
 * Delete an attachment (Owner, Editor; AC-26). The row is deleted first
 * (scoped to the authorized workspace), then the blob, best effort.
 */
export async function deleteAttachment(
  ctx: DataContext,
  input: unknown,
): Promise<{ id: string; pageId: string; workspaceId: string }> {
  const { attachmentId } = parseOrThrow(z.object({ attachmentId: idField }), input);
  const authorized = await authorize(ctx, { attachmentId }, "attachment.delete");

  const [deleted] = await ctx.db
    .delete(attachment)
    .where(and(eq(attachment.id, authorized.resource.id), eq(attachment.workspaceId, authorized.workspaceId)))
    .returning({ id: attachment.id, pageId: attachment.pageId, blobPathname: attachment.blobPathname });
  if (!deleted) {
    // Deleted concurrently.
    throw new NotFoundError();
  }
  await deleteBlobsBestEffort([deleted.blobPathname]);
  return { id: deleted.id, pageId: deleted.pageId, workspaceId: authorized.workspaceId };
}
