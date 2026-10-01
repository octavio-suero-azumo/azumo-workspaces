import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { Sidebar } from "@/components/sidebar";
import { can, canCreateWorkspace } from "@/server/authz/permissions";
import { listSidebarPages } from "@/server/data/home";
import { listMyWorkspaces } from "@/server/data/workspaces";
import { requirePageContext } from "@/server/render-guards";

/**
 * App shell (T-08, E1): sidebar with MY workspaces and their live pages, plus
 * the main column. Everything is read through the requester's memberships on
 * every request (no caching of roles), so a removed member loses the
 * workspace from the sidebar immediately (AC-59).
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { session, ctx } = await requirePageContext();
  const [workspaces, pagesByWorkspace] = await Promise.all([listMyWorkspaces(ctx), listSidebarPages(ctx)]);

  return (
    <AppShell
      sidebar={
        <Sidebar
          user={{ name: session.user.name, email: session.user.email }}
          canCreateWorkspace={canCreateWorkspace(session)}
          workspaces={workspaces.map((w) => ({
            id: w.id,
            name: w.name,
            icon: w.icon,
            role: w.role,
            canCreatePage: can(w.role, "page.create"),
            pages: pagesByWorkspace[w.id] ?? [],
          }))}
        />
      }
    >
      {children}
    </AppShell>
  );
}
