import { and, asc, eq, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { authorize } from "@/server/authz/authorize";
import { MANAGER_ROLE, ROLES, type Role } from "@/server/authz/permissions";
import { membership, user } from "@/server/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import type { DataContext } from "./context";

/**
 * Member management (T-09, R3.1, R3.3, P6, DP3).
 *
 * - Listing: any member (`workspace.view`).
 * - Add / change role / remove: Owner only (`member.*`), enforced by
 *   `authorize()`. The workspace of a membership is always resolved from the
 *   membership row (`{ membershipId }` target), never from client input.
 * - P6: only users who already exist (signed in at least once) can be added.
 *   No invitations.
 * - DP3: the last Owner can be neither demoted nor removed (409). The guard is
 *   a single conditional UPDATE/DELETE with a subquery; no interactive
 *   transaction (architecture §4.10).
 */

export interface MemberView {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
}

/** Result of a member write, with the workspace resolved server-side. */
export interface MemberChange extends MemberView {
  workspaceId: string;
}

export const LAST_OWNER_MESSAGE = "A workspace must keep at least one Owner.";
export const UNKNOWN_USER_MESSAGE =
  "No user with that email has signed in yet. They must sign in once before they can be added.";
export const ALREADY_MEMBER_MESSAGE = "That user is already a member of this workspace.";

const idField = z.string({ error: "Invalid input." });
const roleField = z.enum(ROLES, { error: "Choose a valid role." });

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(result.error.issues[0]?.message ?? "Invalid input.");
  }
  return result.data;
}

/** Members of a workspace the requester belongs to (all roles may view). */
export async function listMembers(ctx: DataContext, workspaceId: string): Promise<MemberView[]> {
  const authorized = await authorize(ctx, { workspaceId }, "workspace.view");
  const rows = await ctx.db
    .select({
      membershipId: membership.id,
      userId: membership.userId,
      name: user.name,
      email: user.email,
      role: membership.role,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.workspaceId, authorized.workspaceId))
    .orderBy(asc(sql`lower(${user.name})`), asc(user.email));
  return rows.map((row) => ({ ...row, role: row.role as Role }));
}

const addMemberInput = z.object({
  email: z.string({ error: "Email is required." }).trim().toLowerCase().pipe(z.email({ error: "Enter a valid email address." })),
  role: roleField,
});

/** Add an existing user to the workspace by email (Owner only, P6). */
export async function addMember(ctx: DataContext, input: unknown): Promise<MemberChange> {
  // Authorize before validating the rest, so a non-member always gets 404.
  const { workspaceId } = parseOrThrow(z.object({ workspaceId: idField }), input);
  const authorized = await authorize(ctx, { workspaceId }, "member.add");
  const { email, role } = parseOrThrow(addMemberInput, input);

  const [existing] = await ctx.db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(sql`lower(${user.email})`, email))
    .limit(1);
  if (!existing) {
    throw new ValidationError(UNKNOWN_USER_MESSAGE);
  }

  const [inserted] = await ctx.db
    .insert(membership)
    .values({ workspaceId: authorized.workspaceId, userId: existing.id, role })
    .onConflictDoNothing({ target: [membership.workspaceId, membership.userId] })
    .returning({ id: membership.id });
  if (!inserted) {
    throw new ConflictError(ALREADY_MEMBER_MESSAGE);
  }

  return {
    membershipId: inserted.id,
    workspaceId: authorized.workspaceId,
    userId: existing.id,
    name: existing.name,
    email: existing.email,
    role,
  };
}

/**
 * True when at least one OTHER Owner remains. The owner rows are locked
 * (`FOR UPDATE`) so two concurrent demotions/removals cannot both see
 * "2 owners" and leave the workspace with none. The rows are locked in a
 * fixed order (`ORDER BY id`, review RV-C-04) so two concurrent guards take
 * the locks in the same sequence instead of deadlocking.
 *
 * Exported only so a test can assert the generated SQL. The concurrency
 * claim itself is NOT verified: PGlite has a single connection (RV-C-04,
 * pending a real Postgres, P4).
 */
export function otherOwnersRemain(workspaceId: string): SQL {
  return sql`(
    select count(*) from (
      select 1 from ${membership} as "owner_row"
      where "owner_row"."workspace_id" = ${workspaceId} and "owner_row"."role" = ${MANAGER_ROLE}
      order by "owner_row"."id"
      for update
    ) as "owners"
  ) > 1`;
}

/** After a guarded write touched 0 rows: last-Owner conflict, or the row is gone. */
async function explainNoRowsAffected(ctx: DataContext, membershipId: string, workspaceId: string): Promise<never> {
  const [still] = await ctx.db
    .select({ id: membership.id })
    .from(membership)
    .where(and(eq(membership.id, membershipId), eq(membership.workspaceId, workspaceId)))
    .limit(1);
  if (still) {
    throw new ConflictError(LAST_OWNER_MESSAGE);
  }
  throw new NotFoundError();
}

/** Change a member's role (Owner only). Demoting the last Owner → 409 (DP3). */
export async function changeMemberRole(ctx: DataContext, input: unknown): Promise<MemberChange> {
  const { membershipId } = parseOrThrow(z.object({ membershipId: idField }), input);
  const authorized = await authorize(ctx, { membershipId }, "member.changeRole");
  const { role } = parseOrThrow(z.object({ role: roleField }), input);
  const target = authorized.resource;

  const guard = role === MANAGER_ROLE ? undefined : or(ne(membership.role, MANAGER_ROLE), otherOwnersRemain(authorized.workspaceId));
  const [updated] = await ctx.db
    .update(membership)
    .set({ role })
    .where(and(eq(membership.id, target.id), eq(membership.workspaceId, authorized.workspaceId), guard))
    .returning({ id: membership.id, userId: membership.userId });
  if (!updated) {
    return explainNoRowsAffected(ctx, target.id, authorized.workspaceId);
  }

  const [member] = await ctx.db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, updated.userId))
    .limit(1);
  return {
    membershipId: updated.id,
    workspaceId: authorized.workspaceId,
    userId: updated.userId,
    name: member?.name ?? "",
    email: member?.email ?? "",
    role,
  };
}

/**
 * Remove a member (Owner only). Removing the last Owner → 409 (DP3). The
 * removed user loses access on their next request, because membership and
 * role are read from the DB on every request.
 */
export async function removeMember(
  ctx: DataContext,
  input: unknown,
): Promise<{ membershipId: string; workspaceId: string }> {
  const { membershipId } = parseOrThrow(z.object({ membershipId: idField }), input);
  const authorized = await authorize(ctx, { membershipId }, "member.remove");
  const target = authorized.resource;

  const [deleted] = await ctx.db
    .delete(membership)
    .where(
      and(
        eq(membership.id, target.id),
        eq(membership.workspaceId, authorized.workspaceId),
        or(ne(membership.role, MANAGER_ROLE), otherOwnersRemain(authorized.workspaceId)),
      ),
    )
    .returning({ id: membership.id });
  if (!deleted) {
    return explainNoRowsAffected(ctx, target.id, authorized.workspaceId);
  }
  return { membershipId: deleted.id, workspaceId: authorized.workspaceId };
}
