import type { Metadata } from "next";
import Link from "next/link";
import { LocalDateTime } from "@/components/local-time";
import { UsersIcon } from "@/components/nav-icons";
import { TopBar } from "@/components/top-bar";
import { DEFAULT_PAGE_ICON, DEFAULT_WORKSPACE_ICON, displayIcon } from "@/lib/icons";
import { can } from "@/server/authz/permissions";
import { listPages } from "@/server/data/pages";
import { getWorkspace } from "@/server/data/workspaces";
import { orNotFound, requirePageContext } from "@/server/render-guards";
import { CreatePageForm } from "./create-page-form";
import { WorkspaceIcon } from "./workspace-header";

const ROLE_LABEL = { owner: "Owner", editor: "Editor", viewer: "Viewer" } as const;

export const metadata: Metadata = { title: "Workspace · Azumo Workspaces" };

/**
 * Workspace home (T-08, T-10; E1/E2). Non-members and unknown ids get a 404
 * (DP2). Lists the workspace's LIVE pages; the "New page" form is rendered
 * only when the requester's role in THIS workspace may create pages (R3.4,
 * AC-18). Owners can change the workspace icon.
 */
export default async function WorkspaceHome({ params }: PageProps<"/w/[workspaceId]">) {
  const { workspaceId } = await params;
  const { ctx } = await requirePageContext();
  const workspace = await orNotFound(getWorkspace(ctx, workspaceId));
  const pages = await orNotFound(listPages(ctx, workspaceId));
  const canCreatePage = can(workspace.role, "page.create");

  return (
    <>
      <TopBar
        crumbs={[{ label: workspace.name, icon: displayIcon(workspace.icon, DEFAULT_WORKSPACE_ICON) }]}
        actions={
          <Link href={`/w/${workspace.id}/members`} className="ui-button-ghost" data-testid="members-link">
            <UsersIcon />
            Members
          </Link>
        }
      />
      <main id="main-content" className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 pb-24 pt-8">
        <header className="flex flex-col gap-2">
          <WorkspaceIcon
            workspaceId={workspace.id}
            icon={workspace.icon}
            canEdit={can(workspace.role, "workspace.edit")}
            name={workspace.name}
          />
          <h1 className="text-4xl font-bold [overflow-wrap:anywhere]" data-testid="workspace-title">
            {workspace.name}
          </h1>
          <p className="text-sm text-muted" data-testid="my-role">
            Your role: {ROLE_LABEL[workspace.role]} · Everyone in this workspace can see its pages, files and calendar.
          </p>
        </header>

        <section aria-labelledby="pages-heading" className="flex flex-col gap-3">
          <h2 id="pages-heading" className="ui-section-title">
            Pages
          </h2>
          {canCreatePage ? <CreatePageForm workspaceId={workspace.id} /> : null}
          {pages.length === 0 ? (
            <p className="text-sm text-muted">No pages yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border" data-testid="page-list">
              {pages.map((page) => (
                <li key={page.id} className="text-sm" data-testid="page-item">
                  <Link
                    href={`/w/${workspace.id}/p/${page.id}`}
                    className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 hover:bg-hover"
                  >
                    <span aria-hidden="true" className="shrink-0 text-lg">
                      {displayIcon(page.icon, DEFAULT_PAGE_ICON)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium" title={page.title}>
                      {page.title}
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      <LocalDateTime iso={page.updatedAt.toISOString()} prefix="Edited" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
