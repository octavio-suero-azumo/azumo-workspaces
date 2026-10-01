import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { assertUploadPathname } from "./attachments";
import { toUploadFileSegment, uploadPathPrefix } from "@/lib/attachment-rules";
import { authorize } from "@/server/authz/authorize";
import { attachment, calendarEvent, page } from "@/server/db/schema";
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from "@/server/errors";
import { copyUploadedBlob, deleteBlobsBestEffort, headUploadedBlob } from "@/server/uploads/blob-store";
import { requireUploadConfig, type UploadConfig } from "@/server/uploads/config";
import type { DataContext } from "./context";

/**
 * Duplicate (E8) and Move to (E9) — PRD §12, planner addendum §2a.
 *
 * Both operations touch two systems that cannot share a transaction: the
 * private Blob store and Postgres. The protocol is:
 *
 * 1. Authorize, then copy every attachment blob to a NEW pathname under the
 *    target prefix (`ws/{workspace}/pg/{page}/…`, random suffix, overwriting
 *    forbidden) and verify each copy with `head()` (same size).
 * 2. ONE database transaction re-checks everything with the current roles and
 *    locks, then switches the rows to the copies.
 * 3. Only after a confirmed commit are the originals deleted (Move). If the
 *    transaction failed, ONLY this attempt's copies are deleted; if the
 *    outcome is unknown (connection lost), the database is re-read first and
 *    nothing is deleted while it cannot be read (orphans accepted, RK-5).
 *
 * A retry after a failure starts again with fresh copies, so it never
 * produces duplicate pages or rows. A repeated Move after success is a no-op.
 */

export const COPY_FAILED_MESSAGE = "Could not copy the attachments. Nothing was changed; please try again.";
export const ATTACHMENTS_CHANGED_MESSAGE =
  "The attachments of this page changed while the operation was running. Nothing was changed; please try again.";
export const PAGE_CHANGED_MESSAGE = "This page changed location while the operation was running. Please reload.";

const idField = z.string({ error: "Invalid input." });

interface SourceAttachment {
  id: string;
  displayName: string;
  contentType: string;
  sizeBytes: number;
  blobPathname: string;
  createdBy: string;
  createdAt: Date;
}

interface BlobCopy {
  source: SourceAttachment;
  pathname: string;
}

async function readAttachments(ctx: DataContext, pageId: string, workspaceId: string): Promise<SourceAttachment[]> {
  return ctx.db
    .select({
      id: attachment.id,
      displayName: attachment.displayName,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      blobPathname: attachment.blobPathname,
      createdBy: attachment.createdBy,
      createdAt: attachment.createdAt,
    })
    .from(attachment)
    .where(and(eq(attachment.pageId, pageId), eq(attachment.workspaceId, workspaceId)))
    .orderBy(asc(attachment.createdAt), asc(attachment.id));
}

/**
 * Copy each attachment blob under `ws/{targetWorkspace}/pg/{targetPage}/` and
 * verify the copies. On any failure, delete the copies made so far and throw.
 */
async function copyAttachments(
  sources: SourceAttachment[],
  targetWorkspaceId: string,
  targetPageId: string,
  config: UploadConfig,
): Promise<BlobCopy[]> {
  const copies: BlobCopy[] = [];
  try {
    for (const source of sources) {
      const requested = `${uploadPathPrefix(targetWorkspaceId, targetPageId)}${toUploadFileSegment(source.displayName)}`;
      const pathname = await copyUploadedBlob(source.blobPathname, requested, source.contentType, config);
      copies.push({ source, pathname });
      // The copy must be a valid pathname for the target page (same rules as
      // uploads) and hold the same number of bytes as the original.
      assertUploadPathname(pathname, targetWorkspaceId, targetPageId);
      const info = await headUploadedBlob(pathname, config);
      if (!info || info.pathname !== pathname || info.size !== source.sizeBytes) {
        throw new Error("blob copy verification failed");
      }
    }
    return copies;
  } catch (error) {
    await deleteBlobsBestEffort(copies.map((copy) => copy.pathname));
    console.error("[page-transfer] attachment copy failed", {
      count: sources.length,
      error: error instanceof Error ? error.message : "unknown error",
    });
    throw new ServiceUnavailableError(COPY_FAILED_MESSAGE);
  }
}

/** Upload config when there are attachments to copy (503 if not configured), otherwise null. */
function configFor(sources: SourceAttachment[]): UploadConfig | null {
  return sources.length > 0 ? requireUploadConfig() : null;
}

function sameAttachmentSet(locked: { id: string; blobPathname: string }[], expected: SourceAttachment[]): boolean {
  if (locked.length !== expected.length) return false;
  const byId = new Map(expected.map((item) => [item.id, item.blobPathname]));
  return locked.every((row) => byId.get(row.id) === row.blobPathname);
}

/** Workspace of a page as currently stored (any state), or "missing"; throws if the DB cannot be read. */
async function currentPageWorkspace(ctx: DataContext, pageId: string): Promise<string | "missing"> {
  const [row] = await ctx.db.select({ workspaceId: page.workspaceId }).from(page).where(eq(page.id, pageId)).limit(1);
  return row?.workspaceId ?? "missing";
}

/**
 * Duplicate a live page in its own workspace (Owner, Editor — `page.duplicate`).
 * Copies title (unchanged, DP17), content, icon and presentation; attachments
 * become independent blobs and rows of the new page. Members and calendar
 * events are not copied. Input: `{ pageId }`. Returns the new page.
 */
export async function duplicatePage(ctx: DataContext, input: unknown): Promise<{ id: string; workspaceId: string }> {
  const parsed = z.object({ pageId: idField }).safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid input.");
  const authorized = await authorize(ctx, { pageId: parsed.data.pageId }, "page.duplicate");
  const workspaceId = authorized.workspaceId;
  const sourceId = authorized.resource.id;

  const [source] = await ctx.db
    .select({
      title: page.title,
      content: page.content,
      icon: page.icon,
      font: page.font,
      smallText: page.smallText,
      fullWidth: page.fullWidth,
    })
    .from(page)
    .where(and(eq(page.id, sourceId), eq(page.workspaceId, workspaceId), isNull(page.deletedAt)))
    .limit(1);
  if (!source) throw new NotFoundError();

  const sources = await readAttachments(ctx, sourceId, workspaceId);
  const config = configFor(sources);
  const newId = randomUUID();
  const copies = config ? await copyAttachments(sources, workspaceId, newId, config) : [];

  try {
    await ctx.db.transaction(async (tx) => {
      const txCtx: DataContext = { db: tx, userId: ctx.userId };
      // Current role, live source (FOR SHARE: no Trash/Move until we commit).
      await authorize(txCtx, { pageId: sourceId }, "page.duplicate");
      const [stillLive] = await tx
        .select({ id: page.id })
        .from(page)
        .where(and(eq(page.id, sourceId), eq(page.workspaceId, workspaceId), isNull(page.deletedAt)))
        .for("share");
      if (!stillLive) throw new NotFoundError();

      await tx.insert(page).values({
        id: newId,
        workspaceId,
        title: source.title,
        content: source.content,
        icon: source.icon,
        font: source.font,
        smallText: source.smallText,
        fullWidth: source.fullWidth,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      if (copies.length > 0) {
        await tx.insert(attachment).values(
          copies.map((copy) => ({
            pageId: newId,
            workspaceId,
            kind: "upload" as const,
            displayName: copy.source.displayName,
            blobPathname: copy.pathname,
            contentType: copy.source.contentType,
            sizeBytes: copy.source.sizeBytes,
            createdBy: ctx.userId,
          })),
        );
      }
    });
  } catch (error) {
    let state: string | "missing" | "unknown";
    try {
      state = await currentPageWorkspace(ctx, newId);
    } catch {
      state = "unknown";
    }
    if (state === workspaceId) {
      // The commit did happen (the error came after it): the duplicate exists.
      return { id: newId, workspaceId };
    }
    if (state === "missing") {
      await deleteBlobsBestEffort(copies.map((copy) => copy.pathname));
    }
    throw error;
  }
  return { id: newId, workspaceId };
}

/**
 * Move a live page to another of the requester's workspaces (E9).
 * Policy (conservative): Owner in the SOURCE workspace (`page.move`) and
 * `page.create` in the DESTINATION. No membership is created or widened: the
 * page and its attachments simply inherit the destination's members.
 *
 * Input: `{ pageId, destinationWorkspaceId }`. Moving a page that is already
 * in the destination is a no-op (idempotent retry). Linked calendar events
 * stay in the source workspace and lose their page link.
 */
export async function movePage(
  ctx: DataContext,
  input: unknown,
): Promise<{ id: string; workspaceId: string; moved: boolean }> {
  const parsed = z.object({ pageId: idField, destinationWorkspaceId: idField }).safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid input.");
  const { pageId, destinationWorkspaceId } = parsed.data;

  const source = await authorize(ctx, { pageId }, "page.move");
  const destination = await authorize(ctx, { workspaceId: destinationWorkspaceId }, "page.create");
  if (destination.workspaceId === source.workspaceId) {
    return { id: source.resource.id, workspaceId: source.workspaceId, moved: false };
  }
  const sourceWorkspaceId = source.workspaceId;
  const destinationId = destination.workspaceId;
  const id = source.resource.id;

  const sources = await readAttachments(ctx, id, sourceWorkspaceId);
  const config = configFor(sources);
  const copies = config ? await copyAttachments(sources, destinationId, id, config) : [];

  try {
    await ctx.db.transaction(async (tx) => {
      const txCtx: DataContext = { db: tx, userId: ctx.userId };
      // Re-authorize with the CURRENT roles (a revoked membership fails here).
      const again = await authorize(txCtx, { pageId: id }, "page.move");
      if (again.workspaceId !== sourceWorkspaceId) throw new ConflictError(PAGE_CHANGED_MESSAGE);
      await authorize(txCtx, { workspaceId: destinationId }, "page.create");

      const [locked] = await tx
        .select({ id: page.id })
        .from(page)
        .where(and(eq(page.id, id), eq(page.workspaceId, sourceWorkspaceId), isNull(page.deletedAt)))
        .for("update");
      if (!locked) throw new NotFoundError();

      // The attachment set must be exactly the one that was copied (an upload
      // or delete in the meantime aborts the move: 409, nothing changes).
      const current = await tx
        .select({ id: attachment.id, blobPathname: attachment.blobPathname })
        .from(attachment)
        .where(and(eq(attachment.pageId, id), eq(attachment.workspaceId, sourceWorkspaceId)))
        .for("update");
      if (!sameAttachmentSet(current, sources)) throw new ConflictError(ATTACHMENTS_CHANGED_MESSAGE);

      // Events stay where they are; only their link to this page is cleared.
      await tx
        .update(calendarEvent)
        .set({ pageId: null, updatedAt: sql`now()` })
        .where(and(eq(calendarEvent.pageId, id), eq(calendarEvent.workspaceId, sourceWorkspaceId)));

      // The pathname-prefix CHECK is per row and immediate, so each attachment
      // changes workspace AND pathname in one statement; the composite FK is
      // deferred until commit, when page and attachments agree again.
      await tx.execute(sql`set constraints "attachment_page_workspace_fk" deferred`);
      await tx
        .update(page)
        .set({ workspaceId: destinationId, updatedBy: ctx.userId, updatedAt: sql`now()` })
        .where(and(eq(page.id, id), eq(page.workspaceId, sourceWorkspaceId)));
      for (const copy of copies) {
        const moved = await tx
          .update(attachment)
          .set({ workspaceId: destinationId, blobPathname: copy.pathname })
          .where(and(eq(attachment.id, copy.source.id), eq(attachment.workspaceId, sourceWorkspaceId)))
          .returning({ id: attachment.id });
        if (moved.length !== 1) throw new ConflictError(ATTACHMENTS_CHANGED_MESSAGE);
      }
    });
  } catch (error) {
    let state: string | "missing" | "unknown";
    try {
      state = await currentPageWorkspace(ctx, id);
    } catch {
      state = "unknown";
    }
    if (state === destinationId) {
      // Committed after all: finish like a success.
      await deleteBlobsBestEffort(sources.map((item) => item.blobPathname));
      return { id, workspaceId: destinationId, moved: true };
    }
    if (state !== "unknown") {
      await deleteBlobsBestEffort(copies.map((copy) => copy.pathname));
    }
    throw error;
  }

  // Committed: the rows point at the copies. Remove the originals (best effort).
  await deleteBlobsBestEffort(sources.map((item) => item.blobPathname));
  return { id, workspaceId: destinationId, moved: true };
}
