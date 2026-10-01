import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { PAGE_TITLE_MAX } from "@/lib/page-content-rules";
import { authorize } from "@/server/authz/authorize";
import type { Role } from "@/server/authz/permissions";
import { attachment, page } from "@/server/db/schema";
import { NotFoundError, ValidationError } from "@/server/errors";
import { deleteBlobsBestEffort } from "@/server/uploads/blob-store";
import type { DataContext } from "./context";
import { parsePageContent, type PageDoc } from "./page-content";

/**
 * Pages (T-10 create/list/view, T-11 edit, T-12 delete; R4.1, PR1, PR2).
 *
 * Authorization (architecture §4–§5, DP2, DP5):
 * - create / list: `authorize({ workspaceId })` with `page.create` /
 *   `workspace.view` (the page list is part of the workspace view).
 * - get / update / delete: `authorize({ pageId })` with `page.view` /
 *   `page.edit` / `page.delete`. The page's workspace is resolved from the
 *   page row, never from input (AC-38). Writes filter by that workspace.
 * - Owner and Editor may create, edit and delete (DP5); every member views.
 *   Non-member → NotFound (404); member without permission → Forbidden (403).
 *
 * Route context: callers may pass the `workspaceId` of the URL the request
 * came from. It is never used to authorize; it only has to MATCH the page's
 * real workspace, otherwise the page is reported as NotFound (a page is only
 * reachable under its own workspace's URL).
 *
 * Deletion is a hard delete (DP4). Attachment rows cascade through their
 * composite FK (T-13); their blobs are collected before the delete and removed
 * from the private Blob store afterwards, best effort (T-16).
 */

export { PAGE_TITLE_MAX } from "@/lib/page-content-rules";

export interface PageSummary {
  id: string;
  title: string;
  updatedAt: Date;
}

export interface PageDetail {
  id: string;
  workspaceId: string;
  title: string;
  /** Tiptap JSON document, or null when the page was created without content. */
  content: PageDoc | null;
  createdAt: Date;
  updatedAt: Date;
  /** The requester's role in the page's workspace (for hiding controls, R3.4). */
  role: Role;
}

export interface PageWriteResult {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt: Date;
}

export const TITLE_REQUIRED_MESSAGE = "Page title is required.";
export const TITLE_TOO_LONG_MESSAGE = `Page title must be at most ${PAGE_TITLE_MAX} characters.`;
export const NOTHING_TO_UPDATE_MESSAGE = "Nothing to update.";

const idField = z.string({ error: "Invalid input." });

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(result.error.issues[0]?.message ?? "Invalid input.");
  }
  return result.data;
}

/** Read one field of an untrusted input object (undefined when absent or not an object). */
function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && Object.hasOwn(input, key)
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

/** Length in Unicode code points, matching Postgres `char_length`. */
const codePoints = (value: string) => Array.from(value).length;

/** Trim, then require 1–200 characters (same rule as the DB CHECK). */
export function parsePageTitle(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ValidationError(TITLE_REQUIRED_MESSAGE);
  }
  const title = raw.trim();
  if (title.length === 0) {
    throw new ValidationError(TITLE_REQUIRED_MESSAGE);
  }
  if (codePoints(title) > PAGE_TITLE_MAX) {
    throw new ValidationError(TITLE_TOO_LONG_MESSAGE);
  }
  return title;
}

/**
 * The route workspace (if the caller passed one) must be the page's real
 * workspace. Absent (undefined/null) means "no route context". Anything else
 * that differs, including non-strings, is NotFound.
 */
function assertRouteWorkspace(routeWorkspaceId: unknown, actualWorkspaceId: string): void {
  if (routeWorkspaceId === undefined || routeWorkspaceId === null) return;
  if (routeWorkspaceId !== actualWorkspaceId) {
    throw new NotFoundError();
  }
}

const pageWriteColumns = {
  id: page.id,
  workspaceId: page.workspaceId,
  title: page.title,
  updatedAt: page.updatedAt,
};

/** Pages of a workspace the requester belongs to (`workspace.view`: page list). */
export async function listPages(ctx: DataContext, workspaceId: string): Promise<PageSummary[]> {
  const authorized = await authorize(ctx, { workspaceId }, "workspace.view");
  return ctx.db
    .select({ id: page.id, title: page.title, updatedAt: page.updatedAt })
    .from(page)
    .where(eq(page.workspaceId, authorized.workspaceId))
    .orderBy(desc(page.updatedAt), asc(page.title), asc(page.id));
}

/**
 * Create a page in a workspace (Owner, Editor). Input:
 * `{ workspaceId, title, content? }`. `content`, when given, must be a valid
 * editor document; otherwise the page starts empty (null).
 */
export async function createPage(ctx: DataContext, input: unknown): Promise<PageWriteResult> {
  // Authorize before validating the rest, so a non-member always gets 404.
  const { workspaceId } = parseOrThrow(z.object({ workspaceId: idField }), input);
  const authorized = await authorize(ctx, { workspaceId }, "page.create");

  const title = parsePageTitle(field(input, "title"));
  const rawContent = field(input, "content");
  const content = rawContent === undefined || rawContent === null ? null : parsePageContent(rawContent);

  const [created] = await ctx.db
    .insert(page)
    .values({ workspaceId: authorized.workspaceId, title, content, createdBy: ctx.userId, updatedBy: ctx.userId })
    .returning(pageWriteColumns);
  return created;
}

/**
 * One page, for any member of its workspace. Input: `{ pageId, workspaceId? }`
 * (`workspaceId` = route context, see above). Missing, foreign or mismatched
 * pages are NotFound.
 */
export async function getPage(ctx: DataContext, input: { pageId: string; workspaceId?: string }): Promise<PageDetail> {
  const { pageId } = parseOrThrow(z.object({ pageId: idField }), input);
  const authorized = await authorize(ctx, { pageId }, "page.view");
  assertRouteWorkspace(field(input, "workspaceId"), authorized.workspaceId);

  const [row] = await ctx.db
    .select({
      id: page.id,
      workspaceId: page.workspaceId,
      title: page.title,
      content: page.content,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    })
    .from(page)
    .where(and(eq(page.id, authorized.resource.id), eq(page.workspaceId, authorized.workspaceId)))
    .limit(1);
  if (!row) {
    throw new NotFoundError();
  }
  return { ...row, content: (row.content ?? null) as PageDoc | null, role: authorized.role };
}

/**
 * Edit a page's title and/or content (Owner, Editor; PR1, PR2). Input:
 * `{ pageId, workspaceId?, title?, content? }`; at least one of title/content.
 */
export async function updatePage(ctx: DataContext, input: unknown): Promise<PageWriteResult> {
  const { pageId } = parseOrThrow(z.object({ pageId: idField }), input);
  const authorized = await authorize(ctx, { pageId }, "page.edit");
  assertRouteWorkspace(field(input, "workspaceId"), authorized.workspaceId);

  const rawTitle = field(input, "title");
  const rawContent = field(input, "content");
  const changes: { title?: string; content?: PageDoc } = {};
  if (rawTitle !== undefined) changes.title = parsePageTitle(rawTitle);
  if (rawContent !== undefined) changes.content = parsePageContent(rawContent);
  if (changes.title === undefined && changes.content === undefined) {
    throw new ValidationError(NOTHING_TO_UPDATE_MESSAGE);
  }

  const [updated] = await ctx.db
    .update(page)
    .set({ ...changes, updatedBy: ctx.userId, updatedAt: sql`now()` })
    .where(and(eq(page.id, authorized.resource.id), eq(page.workspaceId, authorized.workspaceId)))
    .returning(pageWriteColumns);
  if (!updated) {
    // Deleted between authorize() and the write.
    throw new NotFoundError();
  }
  return updated;
}

/**
 * Hard-delete a page (Owner, Editor — DP5; DP4). Input: `{ pageId, workspaceId? }`.
 * Afterwards every read of the page is NotFound. Its attachment rows cascade
 * (composite FK) and their blobs are deleted from the store (best effort).
 */
export async function deletePage(ctx: DataContext, input: unknown): Promise<{ id: string; workspaceId: string }> {
  const { pageId } = parseOrThrow(z.object({ pageId: idField }), input);
  const authorized = await authorize(ctx, { pageId }, "page.delete");
  assertRouteWorkspace(field(input, "workspaceId"), authorized.workspaceId);
  const scope = and(eq(page.id, authorized.resource.id), eq(page.workspaceId, authorized.workspaceId));

  // DP4: read the blob pathnames BEFORE the cascade removes the attachment rows.
  // (An attachment registered between this read and the delete would leave an
  // orphan blob; plan RK-5 accepts orphans for the prototype.)
  const blobs = await ctx.db
    .select({ pathname: attachment.blobPathname })
    .from(attachment)
    .where(and(eq(attachment.pageId, authorized.resource.id), eq(attachment.workspaceId, authorized.workspaceId)));

  const [deleted] = await ctx.db.delete(page).where(scope).returning({ id: page.id });
  if (!deleted) {
    throw new NotFoundError();
  }
  await deleteBlobsBestEffort(blobs.map((blob) => blob.pathname));
  return { id: deleted.id, workspaceId: authorized.workspaceId };
}
