import { and, eq, isNull } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { attachment, calendarEvent, membership, page, workspace } from "@/server/db/schema";
import type { DataContext } from "./context";

/**
 * Resource → membership resolution used by `authorize()` (architecture §4.2).
 *
 * For each target kind this runs ONE query that joins the resource row to the
 * requester's membership on
 *   membership.workspace_id = resource.workspace_id AND membership.user_id = ctx.userId.
 * The workspace is always read from the resource row, never from client input.
 *
 * Returns `null` when the resource does not exist OR the requester is not a
 * member of its workspace (the caller maps both to NotFound, DP2, so a
 * non-member cannot tell them apart).
 *
 * Trash rule (PRD §12.3, DP13): a page whose `deleted_at` is set does NOT
 * resolve — for the page itself and for its attachments — unless the caller
 * passes `includeTrashed` (only `authorize()` does, and only for the actions
 * in `TRASH_VISIBLE_ACTIONS`, i.e. `page.restore`). Fail closed: forgetting
 * the option keeps trashed content unreachable.
 */

export type AuthzTarget =
  | { readonly attachmentId: string }
  | { readonly pageId: string }
  | { readonly membershipId: string }
  | { readonly eventId: string }
  | { readonly workspaceId: string };

export interface ResolveOptions {
  /** Resolve a trashed page too (restore only). Default false. */
  readonly includeTrashed?: boolean;
}

export interface WorkspaceResource {
  id: string;
  name: string;
  icon: string | null;
}

export interface PageResource {
  id: string;
  workspaceId: string;
  title: string;
  /** Null for a live page; set when the page is in Trash (only with `includeTrashed`). */
  deletedAt: Date | null;
}

export interface MembershipResource {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
}

/**
 * An attachment row (T-13). `blobPathname` is server-only: it is used to
 * reach the private Blob store and must never be sent to a client.
 */
export interface AttachmentResource {
  id: string;
  workspaceId: string;
  pageId: string;
  displayName: string;
  contentType: string;
  sizeBytes: number;
  blobPathname: string;
}

/** A calendar event (E4). */
export interface EventResource {
  id: string;
  workspaceId: string;
  title: string;
}

export type ResolvedAccess =
  | { kind: "workspace"; workspaceId: string; role: string; resource: WorkspaceResource }
  | { kind: "page"; workspaceId: string; role: string; resource: PageResource }
  | { kind: "membership"; workspaceId: string; role: string; resource: MembershipResource }
  | { kind: "attachment"; workspaceId: string; role: string; resource: AttachmentResource }
  | { kind: "event"; workspaceId: string; role: string; resource: EventResource };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A non-UUID id cannot match any row; treat it as not found instead of a DB error. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

const requesterMembership = (ctx: DataContext, workspaceIdColumn: AnyPgColumn) =>
  and(eq(membership.workspaceId, workspaceIdColumn), eq(membership.userId, ctx.userId));

/**
 * Resolve the target. Resource IDs take precedence over `workspaceId`: when a
 * target object carries both (for example a spread client payload), the
 * resource's own workspace is used and the client's `workspaceId` is ignored.
 */
export async function resolveAccess(
  ctx: DataContext,
  target: AuthzTarget,
  options: ResolveOptions = {},
): Promise<ResolvedAccess | null> {
  if ("attachmentId" in target) {
    if (!isUuid(target.attachmentId)) return null;
    const [row] = await ctx.db
      .select({
        id: attachment.id,
        workspaceId: attachment.workspaceId,
        pageId: attachment.pageId,
        displayName: attachment.displayName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        blobPathname: attachment.blobPathname,
        role: membership.role,
      })
      .from(attachment)
      // Attachments of a trashed page are unreachable (download, delete).
      .innerJoin(
        page,
        and(eq(page.id, attachment.pageId), eq(page.workspaceId, attachment.workspaceId), isNull(page.deletedAt)),
      )
      .innerJoin(membership, requesterMembership(ctx, attachment.workspaceId))
      .where(eq(attachment.id, target.attachmentId))
      .limit(1);
    if (!row) return null;
    const { role, ...resource } = row;
    return { kind: "attachment", workspaceId: row.workspaceId, role, resource };
  }

  if ("pageId" in target) {
    if (!isUuid(target.pageId)) return null;
    const [row] = await ctx.db
      .select({
        id: page.id,
        workspaceId: page.workspaceId,
        title: page.title,
        deletedAt: page.deletedAt,
        role: membership.role,
      })
      .from(page)
      .innerJoin(membership, requesterMembership(ctx, page.workspaceId))
      .where(
        options.includeTrashed ? eq(page.id, target.pageId) : and(eq(page.id, target.pageId), isNull(page.deletedAt)),
      )
      .limit(1);
    if (!row) return null;
    const { role, ...resource } = row;
    return { kind: "page", workspaceId: row.workspaceId, role, resource };
  }

  if ("membershipId" in target) {
    if (!isUuid(target.membershipId)) return null;
    const targetMembership = alias(membership, "target_membership");
    const [row] = await ctx.db
      .select({
        id: targetMembership.id,
        workspaceId: targetMembership.workspaceId,
        userId: targetMembership.userId,
        role: targetMembership.role,
        requesterRole: membership.role,
      })
      .from(targetMembership)
      .innerJoin(membership, requesterMembership(ctx, targetMembership.workspaceId))
      .where(eq(targetMembership.id, target.membershipId))
      .limit(1);
    if (!row) return null;
    const { requesterRole, ...resource } = row;
    return { kind: "membership", workspaceId: row.workspaceId, role: requesterRole, resource };
  }

  if ("eventId" in target) {
    if (!isUuid(target.eventId)) return null;
    const [row] = await ctx.db
      .select({
        id: calendarEvent.id,
        workspaceId: calendarEvent.workspaceId,
        title: calendarEvent.title,
        role: membership.role,
      })
      .from(calendarEvent)
      .innerJoin(membership, requesterMembership(ctx, calendarEvent.workspaceId))
      .where(eq(calendarEvent.id, target.eventId))
      .limit(1);
    if (!row) return null;
    const { role, ...resource } = row;
    return { kind: "event", workspaceId: row.workspaceId, role, resource };
  }

  if (!isUuid(target.workspaceId)) return null;
  const [row] = await ctx.db
    .select({ id: workspace.id, name: workspace.name, icon: workspace.icon, role: membership.role })
    .from(workspace)
    .innerJoin(membership, requesterMembership(ctx, workspace.id))
    .where(eq(workspace.id, target.workspaceId))
    .limit(1);
  if (!row) return null;
  const { role, ...resource } = row;
  return { kind: "workspace", workspaceId: row.id, role, resource };
}
