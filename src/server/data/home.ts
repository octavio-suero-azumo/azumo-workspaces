import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { membership, page, workspace } from "@/server/db/schema";
import type { DataContext } from "./context";

/**
 * Navigation and Home data (scope expansion E1/E3, 2026-10-01).
 *
 * Every query joins through the requester's membership, so only MY
 * workspaces and their LIVE pages ever appear (no trashed pages, nothing from
 * workspaces I left — membership is read on every request, AC-45, AC-59).
 */

export interface SidebarPage {
  id: string;
  title: string;
  icon: string | null;
}

export interface RecentPage {
  id: string;
  title: string;
  icon: string | null;
  workspaceId: string;
  workspaceName: string;
  workspaceIcon: string | null;
  updatedAt: Date;
}

/** Live pages of every workspace I belong to, grouped by workspace id (sidebar tree). */
export async function listSidebarPages(ctx: DataContext): Promise<Record<string, SidebarPage[]>> {
  const rows = await ctx.db
    .select({ id: page.id, title: page.title, icon: page.icon, workspaceId: page.workspaceId })
    .from(page)
    .innerJoin(membership, and(eq(membership.workspaceId, page.workspaceId), eq(membership.userId, ctx.userId)))
    .where(isNull(page.deletedAt))
    .orderBy(asc(sql`lower(${page.title})`), asc(page.createdAt), asc(page.id));
  const grouped: Record<string, SidebarPage[]> = {};
  for (const row of rows) {
    (grouped[row.workspaceId] ??= []).push({ id: row.id, title: row.title, icon: row.icon });
  }
  return grouped;
}

/** "Recently edited" (by `updated_at`, never "viewed"): my live pages, newest first. */
export async function listRecentPages(ctx: DataContext, limit = 10): Promise<RecentPage[]> {
  return ctx.db
    .select({
      id: page.id,
      title: page.title,
      icon: page.icon,
      workspaceId: page.workspaceId,
      workspaceName: workspace.name,
      workspaceIcon: workspace.icon,
      updatedAt: page.updatedAt,
    })
    .from(page)
    .innerJoin(membership, and(eq(membership.workspaceId, page.workspaceId), eq(membership.userId, ctx.userId)))
    .innerJoin(workspace, eq(workspace.id, page.workspaceId))
    .where(isNull(page.deletedAt))
    .orderBy(desc(page.updatedAt), asc(page.id))
    .limit(Math.min(Math.max(limit, 1), 50));
}

/** Number of live pages per workspace I belong to (Home workspace cards). */
export async function countLivePages(ctx: DataContext): Promise<Record<string, number>> {
  const rows = await ctx.db
    .select({ workspaceId: page.workspaceId, pages: count(page.id) })
    .from(page)
    .innerJoin(membership, and(eq(membership.workspaceId, page.workspaceId), eq(membership.userId, ctx.userId)))
    .where(isNull(page.deletedAt))
    .groupBy(page.workspaceId);
  return Object.fromEntries(rows.map((row) => [row.workspaceId, Number(row.pages)]));
}
