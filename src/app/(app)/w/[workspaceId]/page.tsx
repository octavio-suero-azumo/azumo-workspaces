import Link from "next/link";
import { can } from "@/server/authz/permissions";
import { listPages } from "@/server/data/pages";
import { getWorkspace } from "@/server/data/workspaces";
import { orNotFound, requirePageContext } from "@/server/render-guards";
import { CreatePageForm } from "./create-page-form";

const ROLE_LABEL = { owner: "Owner", editor: "Editor", viewer: "Viewer" } as const;

/**
 * Workspace home (T-08, T-10). Non-members and unknown ids get a 404 (DP2).
 * Lists the workspace's pages; the "New page" form is rendered only when the
 * requester's role in THIS workspace may create pages (R3.4, AC-18).
 */
export default async function WorkspaceHome({ params }: PageProps<"/w/[workspaceId]">) {
  const { workspaceId } = await params;
  const { ctx } = await requirePageContext();
  const workspace = await orNotFound(getWorkspace(ctx, workspaceId));
  const pages = await orNotFound(listPages(ctx, workspaceId));
  const canCreatePage = can(workspace.role, "page.create");

  return (
    <section className="flex flex-col gap-6 p-8">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="workspace-title">
            {workspace.name}
          </h1>
          <p className="text-sm text-neutral-500" data-testid="my-role">
            Your role: {ROLE_LABEL[workspace.role]}
          </p>
        </div>
        <Link href={`/w/${workspace.id}/members`} className="text-sm underline underline-offset-2">
          Members
        </Link>
      </header>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">Pages</h2>
        {canCreatePage ? <CreatePageForm workspaceId={workspace.id} /> : null}
        {pages.length === 0 ? (
          <p className="text-sm text-neutral-500">No pages yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-200 rounded border border-neutral-200" data-testid="page-list">
            {pages.map((page) => (
              <li key={page.id} className="text-sm" data-testid="page-item">
                <Link href={`/w/${workspace.id}/p/${page.id}`} className="block px-3 py-2 hover:bg-neutral-50">
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
