import {
  resolveAccess,
  type AttachmentResource,
  type AuthzTarget,
  type MembershipResource,
  type PageResource,
  type WorkspaceResource,
} from "@/server/data/access";
import type { DataContext } from "@/server/data/context";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { can, isRole, type Action, type Role } from "./permissions";

export type { AuthzTarget } from "@/server/data/access";

/**
 * Single authorization entry point (T-05, architecture §4.2, R3.2).
 *
 *   authorize(ctx, target, action)
 *
 * - `target` is `{ workspaceId }`, `{ pageId }`, `{ attachmentId }` or
 *   `{ membershipId }`. For resource targets the workspace is resolved from
 *   the resource row, never from client input (RV-07, AC-38).
 * - One query joins the resource to the requester's membership
 *   (`resolveAccess`). The role is read from the DB on every call; nothing is
 *   cached (architecture §4.9, AC-16, AC-37).
 * - No row (resource missing, or requester not a member): `NotFoundError`
 *   (404, DP2). Member without permission: `ForbiddenError` (403).
 * - Otherwise returns the authorized `workspaceId`, the requester's `role`
 *   and the resource. Writes must filter by this `workspaceId`.
 *
 * `{ attachmentId }` (T-13) resolves the attachment's workspace from the
 * attachment row, which the composite FK keeps equal to its page's workspace.
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
  target: { readonly workspaceId: string },
  action: Action,
): Promise<Authorized<WorkspaceResource>>;
export async function authorize(
  ctx: DataContext,
  target: AuthzTarget,
  action: Action,
): Promise<Authorized<WorkspaceResource | PageResource | MembershipResource | AttachmentResource>> {
  const access = await resolveAccess(ctx, target);
  if (!access) {
    throw new NotFoundError();
  }
  if (!isRole(access.role) || !can(access.role, action)) {
    throw new ForbiddenError();
  }
  return { workspaceId: access.workspaceId, role: access.role, resource: access.resource };
}
