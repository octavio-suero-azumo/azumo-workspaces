import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { isIconChoice } from "@/lib/icons";
import { PAGE_TITLE_MAX } from "@/lib/page-content-rules";
import { isPageFont, type PageFont } from "@/lib/page-presentation";
import { authorize } from "@/server/authz/authorize";
import { can, type Role } from "@/server/authz/permissions";
import { membership, page, user, workspace } from "@/server/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import type { DataContext } from "./context";
import { parsePageContent, type PageDoc } from "./page-content";

/**
 * Pages (T-10 create/list/view, T-11 edit; R4.1, PR1, PR2) and the scope
 * expansion of 2026-10-01 (PRD §12): icons (E2), shared presentation (E5),
 * Trash and Restore (E10).
 *
 * Authorization (architecture §4–§5, DP2, PRD §12.3):
 * - create / list: `authorize({ workspaceId })` with `page.create` /
 *   `workspace.view` (the page list is part of the workspace view).
 * - get / update / icon / presentation / trash: `authorize({ pageId })`. The
 *   page's workspace is resolved from the page row, never from input
 *   (AC-38). Writes filter by that workspace AND `deleted_at IS NULL`, so a
 *   page trashed or moved after `authorize()` is never written (AC-56).
 * - restore: `authorize({ pageId }, "page.restore")`, the only action that
 *   resolves a trashed page.
 *
 * Route context: callers may pass the `workspaceId` of the URL the request
 * came from. It is never used to authorize; it only has to MATCH the page's
 * real workspace, otherwise the page is reported as NotFound (DP16).
 *
 * DP13: there is no permanent page delete any more. Trash keeps the page,
 * its content, its attachment rows and their blobs.
 */

export { PAGE_TITLE_MAX } from "@/lib/page-content-rules";

export interface PageSummary {
  id: string;
  title: string;
  icon: string | null;
  updatedAt: Date;
}

export interface PageDetail {
  id: string;
  workspaceId: string;
  title: string;
  icon: string | null;
  font: PageFont;
  smallText: boolean;
  fullWidth: boolean;
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

export interface TrashedPage {
  id: string;
  title: string;
  icon: string | null;
  workspaceId: string;
  workspaceName: string;
  workspaceIcon: string | null;
  deletedAt: Date;
  deletedByName: string | null;
}

export const TITLE_REQUIRED_MESSAGE = "Page title is required.";
export const TITLE_TOO_LONG_MESSAGE = `Page title must be at most ${PAGE_TITLE_MAX} characters.`;
export const NOTHING_TO_UPDATE_MESSAGE = "Nothing to update.";
export const INVALID_ICON_MESSAGE = "Choose an icon from the list.";
export const INVALID_PRESENTATION_MESSAGE = "Invalid page style.";
export const NOT_IN_TRASH_MESSAGE = "This page is not in Trash.";
export const PAGE_GONE_MESSAGE = "This page was moved or sent to Trash. Copy your changes, then reopen the page.";

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

/** An icon from the curated allowlist, or null (= default icon / reset). Anything else is 400. */
export function parseIcon(raw: unknown): string | null {
  if (raw === null) return null;
  if (!isIconChoice(raw)) {
    throw new ValidationError(INVALID_ICON_MESSAGE);
  }
  return raw;
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

/** Write scope: the authorized page, in the authorized workspace, still live. */
const liveScope = (pageId: string, workspaceId: string) =>
  and(eq(page.id, pageId), eq(page.workspaceId, workspaceId), isNull(page.deletedAt));

/** Live pages of a workspace the requester belongs to (`workspace.view`: page list). */
export async function listPages(ctx: DataContext, workspaceId: string): Promise<PageSummary[]> {
  const authorized = await authorize(ctx, { workspaceId }, "workspace.view");
  return ctx.db
    .select({ id: page.id, title: page.title, icon: page.icon, updatedAt: page.updatedAt })
    .from(page)
    .where(and(eq(page.workspaceId, authorized.workspaceId), isNull(page.deletedAt)))
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
 * One live page, for any member of its workspace. Input:
 * `{ pageId, workspaceId? }` (`workspaceId` = route context, see above).
 * Missing, foreign, trashed or mismatched pages are NotFound.
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
      icon: page.icon,
      font: page.font,
      smallText: page.smallText,
      fullWidth: page.fullWidth,
      content: page.content,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    })
    .from(page)
    .where(liveScope(authorized.resource.id, authorized.workspaceId))
    .limit(1);
  if (!row) {
    throw new NotFoundError();
  }
  return {
    ...row,
    font: isPageFont(row.font) ? row.font : "default",
    content: (row.content ?? null) as PageDoc | null,
    role: authorized.role,
  };
}

/**
 * Edit a page's title and/or content (Owner, Editor; PR1, PR2). Input:
 * `{ pageId, workspaceId?, title?, content? }`; at least one of title/content.
 * A page moved or trashed after the editor loaded is NotFound (AC-56).
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
    .where(liveScope(authorized.resource.id, authorized.workspaceId))
    .returning(pageWriteColumns);
  if (!updated) {
    // Trashed or moved between authorize() and the write.
    throw new NotFoundError(PAGE_GONE_MESSAGE);
  }
  return updated;
}

/** Set or reset (null) a page's icon (Owner, Editor; E2). Input: `{ pageId, icon }`. */
export async function updatePageIcon(ctx: DataContext, input: unknown): Promise<PageWriteResult & { icon: string | null }> {
  const { pageId } = parseOrThrow(z.object({ pageId: idField }), input);
  const authorized = await authorize(ctx, { pageId }, "page.edit");
  const icon = parseIcon(field(input, "icon") ?? null);

  const [updated] = await ctx.db
    .update(page)
    .set({ icon, updatedBy: ctx.userId, updatedAt: sql`now()` })
    .where(liveScope(authorized.resource.id, authorized.workspaceId))
    .returning({ ...pageWriteColumns, icon: page.icon });
  if (!updated) throw new NotFoundError(PAGE_GONE_MESSAGE);
  return updated;
}

const presentationInput = z
  .object({
    font: z.string().optional(),
    smallText: z.boolean().optional(),
    fullWidth: z.boolean().optional(),
  })
  .strict();

/**
 * Change the shared presentation of a page (Owner, Editor; E5). Input:
 * `{ pageId, font?, smallText?, fullWidth? }` — enum and booleans only, never
 * CSS. Presentation is not content, so `updated_at` is not touched.
 */
export async function updatePagePresentation(
  ctx: DataContext,
  input: unknown,
): Promise<{ id: string; workspaceId: string; font: PageFont; smallText: boolean; fullWidth: boolean }> {
  const { pageId } = parseOrThrow(z.object({ pageId: idField }), input);
  const authorized = await authorize(ctx, { pageId }, "page.edit");

  const rest = typeof input === "object" && input !== null ? { ...(input as Record<string, unknown>) } : {};
  delete rest.pageId;
  const parsed = presentationInput.safeParse(rest);
  if (!parsed.success) throw new ValidationError(INVALID_PRESENTATION_MESSAGE);
  const changes: { font?: PageFont; smallText?: boolean; fullWidth?: boolean } = {};
  if (parsed.data.font !== undefined) {
    if (!isPageFont(parsed.data.font)) throw new ValidationError(INVALID_PRESENTATION_MESSAGE);
    changes.font = parsed.data.font;
  }
  if (parsed.data.smallText !== undefined) changes.smallText = parsed.data.smallText;
  if (parsed.data.fullWidth !== undefined) changes.fullWidth = parsed.data.fullWidth;
  if (Object.keys(changes).length === 0) throw new ValidationError(NOTHING_TO_UPDATE_MESSAGE);

  const [updated] = await ctx.db
    .update(page)
    .set(changes)
    .where(liveScope(authorized.resource.id, authorized.workspaceId))
    .returning({
      id: page.id,
      workspaceId: page.workspaceId,
      font: page.font,
      smallText: page.smallText,
      fullWidth: page.fullWidth,
    });
  if (!updated) throw new NotFoundError(PAGE_GONE_MESSAGE);
  return { ...updated, font: isPageFont(updated.font) ? updated.font : "default" };
}

/**
 * Move a page to Trash (Owner, Editor; E10, DP13). Soft delete only: the
 * content, attachment rows and blobs are kept. Input: `{ pageId, workspaceId? }`.
 */
export async function trashPage(ctx: DataContext, input: unknown): Promise<{ id: string; workspaceId: string }> {
  const { pageId } = parseOrThrow(z.object({ pageId: idField }), input);
  const authorized = await authorize(ctx, { pageId }, "page.trash");
  assertRouteWorkspace(field(input, "workspaceId"), authorized.workspaceId);

  const [trashed] = await ctx.db
    .update(page)
    .set({ deletedAt: sql`now()`, deletedBy: ctx.userId })
    .where(liveScope(authorized.resource.id, authorized.workspaceId))
    .returning({ id: page.id });
  if (!trashed) throw new NotFoundError();
  return { id: trashed.id, workspaceId: authorized.workspaceId };
}

/**
 * Restore a trashed page to its original workspace (Owner, Editor — the
 * CURRENT role is checked; a removed member gets 404). Same id, content,
 * icon, presentation and attachments. Input: `{ pageId }`.
 */
export async function restorePage(ctx: DataContext, input: unknown): Promise<{ id: string; workspaceId: string }> {
  const { pageId } = parseOrThrow(z.object({ pageId: idField }), input);
  const authorized = await authorize(ctx, { pageId }, "page.restore");
  if (authorized.resource.deletedAt === null) {
    throw new ConflictError(NOT_IN_TRASH_MESSAGE);
  }

  const [restored] = await ctx.db
    .update(page)
    .set({ deletedAt: null, deletedBy: null })
    .where(
      and(eq(page.id, authorized.resource.id), eq(page.workspaceId, authorized.workspaceId), isNotNull(page.deletedAt)),
    )
    .returning({ id: page.id });
  if (!restored) throw new ConflictError(NOT_IN_TRASH_MESSAGE);
  return { id: restored.id, workspaceId: authorized.workspaceId };
}

/**
 * Trashed pages of the workspaces where the requester may manage Trash
 * (`trash.view`: Owner, Editor — DP15). Newest first.
 */
export async function listTrash(ctx: DataContext): Promise<TrashedPage[]> {
  const managerRoles = (["owner", "editor", "viewer"] as const).filter((role) => can(role, "trash.view"));
  const rows = await ctx.db
    .select({
      id: page.id,
      title: page.title,
      icon: page.icon,
      workspaceId: page.workspaceId,
      workspaceName: workspace.name,
      workspaceIcon: workspace.icon,
      deletedAt: page.deletedAt,
      deletedByName: user.name,
    })
    .from(page)
    .innerJoin(
      membership,
      and(
        eq(membership.workspaceId, page.workspaceId),
        eq(membership.userId, ctx.userId),
        inArray(membership.role, managerRoles),
      ),
    )
    .innerJoin(workspace, eq(workspace.id, page.workspaceId))
    .leftJoin(user, eq(user.id, page.deletedBy))
    .where(isNotNull(page.deletedAt))
    .orderBy(desc(page.deletedAt), asc(page.id));
  return rows.map((row) => ({ ...row, deletedAt: row.deletedAt as Date }));
}
