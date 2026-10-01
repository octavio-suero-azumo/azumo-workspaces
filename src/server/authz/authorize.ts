import {
  resolveAccess,
  type AttachmentResource,
  type AuthzTarget,
  type EventResource,
  type MembershipResource,
  type PageResource,
  type WorkspaceResource,
} from "@/server/data/access";
import type { DataContext } from "@/server/data/context";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { can, isRole, TRASH_VISIBLE_ACTIONS, type Action, type Role } from "./permissions";

export type { AuthzTarget } from "@/server/data/access";

/**
 * Single authorization entry point (T-05, architecture §4.2, R3.2).
 *
 *   authorize(ctx, target, action)
 *
 * - `target` is `{ workspaceId }`, `{ pageId }`, `{ attachmentId }`,
 *   `{ membershipId }` or `{ eventId }`. For resource targets the workspace is
 *   resolved from the resource row, never from client input (RV-07, AC-38).
 * - One query joins the resource to the requester's membership
 *   (`resolveAccess`). The role is read from the DB on every call; nothing is
 *   cached (architecture §4.9, AC-16, AC-37).
 * - No row (resource missing, or requester not a member): `NotFoundError`
 *   (404, DP2). Member without permission: `ForbiddenError` (403).
 * - A TRASHED page (and its attachments) resolves only for the actions in
 *   `TRASH_VISIBLE_ACTIONS` (`page.restore`); for everything else it is
 *   NotFound (PRD §12.3, DP13).
 * - Otherwise returns the authorized `workspaceId`, the requester's `role`
 *   and the resource. Writes must filter by this `workspaceId`.
 */

export interface Authorized<R> {
  workspaceId: string;
  role: Role;
  resource: R;
}

export function authorize(
  ctx: DataContext,
  target: { readonly attachmentId: string },
  action: Action,
): Promise<Authorized<AttachmentResource>>;
export function authorize(
  ctx: DataContext,
  target: { readonly pageId: string },
  action: Action,
): Promise<Authorized<PageResource>>;
export function authorize(
  ctx: DataContext,
  target: { readonly membershipId: string },
  action: Action,
): Promise<Authorized<MembershipResource>>;
export function authorize(
  ctx: DataContext,
  target: { readonly eventId: string },
  action: Action,
): Promise<Authorized<EventResource>>;
export function authorize(
  ctx: DataContext,
  target: { readonly workspaceId: string },
  action: Action,
): Promise<Authorized<WorkspaceResource>>;
export async function authorize(
  ctx: DataContext,
  target: AuthzTarget,
  action: Action,
): Promise<Authorized<WorkspaceResource | PageResource | MembershipResource | AttachmentResource | EventResource>> {
  const access = await resolveAccess(ctx, target, { includeTrashed: TRASH_VISIBLE_ACTIONS.has(action) });
  if (!access) {
    throw new NotFoundError();
  }
  if (!isRole(access.role) || !can(access.role, action)) {
    throw new ForbiddenError();
  }
  return { workspaceId: access.workspaceId, role: access.role, resource: access.resource };
}
