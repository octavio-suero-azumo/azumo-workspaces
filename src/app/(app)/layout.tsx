import type { ReactNode } from "react";
import { canCreateWorkspace } from "@/server/authz/permissions";
import { listMyWorkspaces } from "@/server/data/workspaces";
import { requirePageContext } from "@/server/render-guards";
import { SignOutButton } from "../sign-out-button";
import { CreateWorkspaceForm } from "./create-workspace-form";
import { WorkspaceLinks } from "./workspace-links";

/** App shell: sidebar with my workspaces + create form (T-08). */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { session, ctx } = await requirePageContext();
  const workspaces = await listMyWorkspaces(ctx);

  return (
    <div className="flex min-h-screen flex-1">
      <aside className="flex w-64 shrink-0 flex-col gap-6 border-r border-neutral-200 bg-neutral-50 p-4">
        <div>
          <p className="text-sm font-semibold">Azumo Workspaces</p>
          <p className="truncate text-xs text-neutral-500" data-testid="signed-in-as">
            {session.user.email}
          </p>
        </div>
        <nav aria-label="Workspaces" className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Workspaces</p>
          <WorkspaceLinks workspaces={workspaces} />
        </nav>
        {canCreateWorkspace(session) ? <CreateWorkspaceForm /> : null}
        <div className="mt-auto">
          <SignOutButton />
        </div>
      </aside>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
