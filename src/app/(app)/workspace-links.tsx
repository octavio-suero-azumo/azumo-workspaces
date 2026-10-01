"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

export interface WorkspaceLink {
  id: string;
  name: string;
  role: string;
}

const ROLE_LABEL: Readonly<Record<string, string>> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

/** Sidebar list of MY workspaces (R2.1). Switching = navigating (R2.4). */
export function WorkspaceLinks({ workspaces }: { workspaces: WorkspaceLink[] }) {
  const params = useParams<{ workspaceId?: string }>();
  const activeId = params?.workspaceId;

  if (workspaces.length === 0) {
    return <p className="text-sm text-neutral-500">No workspaces yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-1" data-testid="workspace-list">
      {workspaces.map((workspace) => {
        const active = workspace.id === activeId;
        return (
          <li key={workspace.id}>
            <Link
              href={`/w/${workspace.id}`}
              aria-current={active ? "page" : undefined}
              data-testid="workspace-link"
              className={`flex items-center justify-between gap-2 rounded px-2 py-1 text-sm ${
                active ? "bg-neutral-200 font-medium" : "hover:bg-neutral-100"
              }`}
            >
              <span className="truncate" data-testid="workspace-name">
                {workspace.name}
              </span>
              <span className="shrink-0 text-xs text-neutral-500">{ROLE_LABEL[workspace.role] ?? workspace.role}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
