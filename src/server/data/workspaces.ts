import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { authorize } from "@/server/authz/authorize";
import { canCreateWorkspace, MANAGER_ROLE, type Role } from "@/server/authz/permissions";
import { membership, workspace } from "@/server/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import type { DataContext } from "./context";
import { NOTHING_TO_UPDATE_MESSAGE, parseIcon } from "./pages";

/**
 * Workspace data functions (T-08, R2.1, R2.2, R2.4). Every function takes the
 * requester context and scopes by membership (architecture §4.4).
 *
 * Scope expansion E2/E6 (2026-10-01): workspace icon and rename by the Owner
 * (`workspace.edit`).
 */

export const WORKSPACE_NAME_MAX = 100;

export interface WorkspaceSummary {
  id: string;
  name: string;
  icon: string | null;
  role: Role;
}

/** Length in Unicode code points, matching Postgres `char_length`. */
const codePoints = (value: string) => Array.from(value).length;

const createWorkspaceInput = z.object({ name: z.string() });

/**
 * Trim, then require 1–100 characters (AC-09). Whitespace-only names become
 * empty after trimming and are rejected.
 */
export function parseWorkspaceName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ValidationError("Workspace name is required.");
  }
  const name = raw.trim();
  if (name.length === 0) {
    throw new ValidationError("Workspace name is required.");
  }
  if (codePoints(name) > WORKSPACE_NAME_MAX) {
    throw new ValidationError(`Workspace name must be at most ${WORKSPACE_NAME_MAX} characters.`);
  }
  return name;
}

/**
 * Create a workspace and the creator's Owner membership (R2.2, AC-09, P5).
 *
 * Both rows are written by ONE statement (a data-modifying CTE), so they are
 * atomic without an interactive transaction (works with any Postgres driver).
 */
export async function createWorkspace(ctx: DataContext, input: unknown): Promise<WorkspaceSummary> {
  if (!canCreateWorkspace(ctx)) {
    throw new ForbiddenError();
  }
  const parsed = createWorkspaceInput.safeParse(input);
  const name = parseWorkspaceName(parsed.success ? parsed.data.name : undefined);

  const id = randomUUID();
  const insertedWorkspace = ctx.db
    .$with("inserted_workspace")
    .as(ctx.db.insert(workspace).values({ id, name, createdBy: ctx.userId }).returning({ id: workspace.id }));
  await ctx.db
    .with(insertedWorkspace)
    .insert(membership)
    .values({ workspaceId: id, userId: ctx.userId, role: MANAGER_ROLE });

  return { id, name, icon: null, role: MANAGER_ROLE };
}

/** Only the workspaces where the requester is a member (R2.1, AC-08). */
export async function listMyWorkspaces(ctx: DataContext): Promise<WorkspaceSummary[]> {
  const rows = await ctx.db
    .select({ id: workspace.id, name: workspace.name, icon: workspace.icon, role: membership.role })
    .from(membership)
    .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
    .where(eq(membership.userId, ctx.userId))
    .orderBy(asc(sql`lower(${workspace.name})`), asc(workspace.createdAt), asc(workspace.id));
  return rows.map((row) => ({ ...row, role: row.role as Role }));
}

/** One workspace the requester belongs to. Non-member or unknown id: NotFound. */
export async function getWorkspace(ctx: DataContext, workspaceId: string): Promise<WorkspaceSummary> {
  const { resource, role } = await authorize(ctx, { workspaceId }, "workspace.view");
  return { id: resource.id, name: resource.name, icon: resource.icon, role };
}

/**
 * Rename a workspace and/or change its icon (Owner only, `workspace.edit`;
 * E2, E6). Input: `{ workspaceId, name?, icon? }` — `icon: null` resets it.
 */
export async function updateWorkspace(ctx: DataContext, input: unknown): Promise<WorkspaceSummary> {
  const parsed = z.object({ workspaceId: z.string({ error: "Invalid input." }) }).safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid input.");
  const authorized = await authorize(ctx, { workspaceId: parsed.data.workspaceId }, "workspace.edit");

  const record = input as Record<string, unknown>;
  const changes: { name?: string; icon?: string | null } = {};
  if (Object.hasOwn(record, "name") && record.name !== undefined) changes.name = parseWorkspaceName(record.name);
  if (Object.hasOwn(record, "icon") && record.icon !== undefined) changes.icon = parseIcon(record.icon);
  if (Object.keys(changes).length === 0) throw new ValidationError(NOTHING_TO_UPDATE_MESSAGE);

  const [updated] = await ctx.db
    .update(workspace)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(and(eq(workspace.id, authorized.workspaceId)))
    .returning({ id: workspace.id, name: workspace.name, icon: workspace.icon });
  if (!updated) throw new NotFoundError();
  return { ...updated, role: authorized.role };
}
