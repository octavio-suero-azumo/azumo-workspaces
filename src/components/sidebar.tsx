"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { createPageAction } from "@/app/(app)/w/[workspaceId]/p/actions";
import { useSidebar } from "@/components/app-shell";
import { CreateWorkspaceDialog } from "@/components/create-workspace-dialog";
import {
  CalendarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  HomeIcon,
  PlusIcon,
  SettingsIcon,
  SidebarIcon,
  SignOutIcon,
  TrashIcon,
} from "@/components/nav-icons";
import { Menu } from "@/components/ui/menu";
import { authClient } from "@/lib/auth-client";
import { DEFAULT_PAGE_ICON, DEFAULT_WORKSPACE_ICON, displayIcon } from "@/lib/icons";

/*
 * Sidebar (E1): workspace switcher, Home, Calendar, the tree of MY workspaces
 * with their live pages, New page (only where the role may create pages —
 * R3.4; the server enforces it anyway), New workspace, Trash, Settings and the
 * signed-in account with Sign out. Data comes from the server layout, which
 * reads it through the requester's memberships.
 */

export interface SidebarWorkspace {
  id: string;
  name: string;
  icon: string | null;
  role: string;
  canCreatePage: boolean;
  pages: { id: string; title: string; icon: string | null }[];
}

export interface SidebarProps {
  user: { name: string; email: string };
  workspaces: SidebarWorkspace[];
  canCreateWorkspace: boolean;
}

const ROLE_LABEL: Readonly<Record<string, string>> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

export function Sidebar({ user, workspaces, canCreateWorkspace }: SidebarProps) {
  const pathname = usePathname();
  const params = useParams<{ workspaceId?: string; pageId?: string }>();
  const router = useRouter();
  const { toggle } = useSidebar();
  const activeWorkspaceId = params?.workspaceId;
  const activePageId = params?.pageId;
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(activeWorkspaceId ? [activeWorkspaceId] : []));
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);

  const isExpanded = (id: string) => expanded.has(id) || id === activeWorkspaceId;
  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (isExpanded(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <aside className="app-sidebar" aria-label="Sidebar" data-testid="sidebar">
      <div className="flex items-center gap-1 px-2 pb-1 pt-2">
        <Menu
          label="Switch workspace"
          align="start"
          testId="workspace-switcher"
          triggerClassName="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
          trigger={
            <>
              <span
                aria-hidden="true"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-active text-sm"
              >
                {activeWorkspace ? displayIcon(activeWorkspace.icon, DEFAULT_WORKSPACE_ICON) : "A"}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-semibold text-fg">Azumo Workspaces</span>
                <span className="truncate text-xs text-muted">{activeWorkspace ? activeWorkspace.name : "All workspaces"}</span>
              </span>
              <ChevronDownIcon className="ml-auto shrink-0 text-muted" width={14} height={14} />
            </>
          }
          sections={[
            {
              key: "workspaces",
              label: "Your workspaces",
              items:
                workspaces.length > 0
                  ? workspaces.map((w) => ({
                      key: w.id,
                      label: w.name,
                      icon: <span>{displayIcon(w.icon, DEFAULT_WORKSPACE_ICON)}</span>,
                      hint: ROLE_LABEL[w.role] ?? w.role,
                      onSelect: () => router.push(`/w/${w.id}`),
                    }))
                  : [{ key: "none", label: "No workspaces yet", onSelect: () => router.push("/") }],
            },
            ...(canCreateWorkspace
              ? [
                  {
                    key: "create",
                    items: [
                      {
                        key: "new-workspace",
                        label: "New workspace",
                        icon: <PlusIcon />,
                        onSelect: () => setCreatingWorkspace(true),
                      },
                    ],
                  },
                ]
              : []),
          ]}
        />
        <button type="button" aria-label="Collapse sidebar" onClick={toggle} className="ui-icon-button" data-testid="sidebar-collapse">
          <SidebarIcon />
        </button>
      </div>

      <nav aria-label="Main" className="flex flex-col gap-0.5 px-2 py-1">
        <Link href="/" className="ui-sidebar-item" aria-current={pathname === "/" ? "page" : undefined} data-testid="nav-home">
          <HomeIcon />
          <span>Home</span>
        </Link>
        <Link
          href="/calendar"
          className="ui-sidebar-item"
          aria-current={pathname.startsWith("/calendar") ? "page" : undefined}
          data-testid="nav-calendar"
        >
          <CalendarIcon />
          <span>Calendar</span>
        </Link>
      </nav>

      <nav aria-label="Workspaces" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2">
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="ui-section-title">Workspaces</span>
          {canCreateWorkspace ? (
            <button
              type="button"
              className="ui-icon-button h-6 w-6"
              aria-label="New workspace"
              onClick={() => setCreatingWorkspace(true)}
              data-testid="new-workspace-button"
            >
              <PlusIcon />
            </button>
          ) : null}
        </div>
        {workspaces.length === 0 ? (
          <p className="px-2 text-sm text-muted">No workspaces yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5" data-testid="workspace-list">
            {workspaces.map((w) => {
              const open = isExpanded(w.id);
              const workspaceActive = w.id === activeWorkspaceId && !activePageId && pathname === `/w/${w.id}`;
              return (
                <li key={w.id}>
                  <div className="group flex items-center">
                    <button
                      type="button"
                      className="ui-icon-button h-6 w-6"
                      aria-label={`${open ? "Collapse" : "Expand"} ${w.name}`}
                      aria-expanded={open}
                      onClick={() => toggleExpanded(w.id)}
                    >
                      {open ? <ChevronDownIcon width={12} height={12} /> : <ChevronRightIcon width={12} height={12} />}
                    </button>
                    <Link
                      href={`/w/${w.id}`}
                      className="ui-sidebar-item min-w-0 flex-1"
                      aria-current={workspaceActive ? "page" : undefined}
                      data-testid="workspace-link"
                      title={w.name}
                    >
                      <span aria-hidden="true" className="shrink-0">
                        {displayIcon(w.icon, DEFAULT_WORKSPACE_ICON)}
                      </span>
                      <span className="truncate" data-testid="workspace-name">
                        {w.name}
                      </span>
                      <span className="sr-only"> ({ROLE_LABEL[w.role] ?? w.role})</span>
                    </Link>
                    {w.canCreatePage ? <NewPageButton workspaceId={w.id} workspaceName={w.name} /> : null}
                  </div>
                  {open ? (
                    <ul className="ml-4 flex flex-col gap-0.5 border-l border-border pl-1" data-testid="sidebar-pages">
                      {w.pages.length === 0 ? (
                        <li className="px-2 py-1 text-xs text-muted">No pages</li>
                      ) : (
                        w.pages.map((p) => (
                          <li key={p.id}>
                            <Link
                              href={`/w/${w.id}/p/${p.id}`}
                              className="ui-sidebar-item"
                              aria-current={p.id === activePageId ? "page" : undefined}
                              title={p.title}
                              data-testid="sidebar-page-link"
                            >
                              <span aria-hidden="true" className="shrink-0">
                                {displayIcon(p.icon, DEFAULT_PAGE_ICON)}
                              </span>
                              <span className="truncate">{p.title}</span>
                            </Link>
                          </li>
                        ))
                      )}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <div className="flex flex-col gap-0.5 border-t border-border px-2 py-2">
        <Link href="/trash" className="ui-sidebar-item" aria-current={pathname === "/trash" ? "page" : undefined} data-testid="nav-trash">
          <TrashIcon />
          <span>Trash</span>
        </Link>
        <Link
          href="/settings"
          className="ui-sidebar-item"
          aria-current={pathname === "/settings" ? "page" : undefined}
          data-testid="nav-settings"
        >
          <SettingsIcon />
          <span>Settings</span>
        </Link>
        <div className="mt-1 flex items-center gap-2 rounded-md px-2 py-1.5">
          <span
            aria-hidden="true"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-active text-xs font-semibold text-fg"
          >
            {(user.name || user.email).charAt(0).toUpperCase()}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-fg">{user.name}</span>
            <span className="truncate text-xs text-muted" data-testid="signed-in-as">
              {user.email}
            </span>
          </span>
          <SidebarSignOut />
        </div>
      </div>

      <CreateWorkspaceDialog open={creatingWorkspace} onClose={() => setCreatingWorkspace(false)} />
    </aside>
  );
}

type CreatePageState = Awaited<ReturnType<typeof createPageAction>> | null;

/** "+" next to a workspace: creates an "Untitled" page there and opens it. */
function NewPageButton({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const [state, formAction, pending] = useActionState<CreatePageState, FormData>(createPageAction, null);
  return (
    <form action={formAction} className="flex shrink-0 items-center">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="title" value="Untitled" />
      <button
        type="submit"
        disabled={pending}
        className="ui-icon-button h-6 w-6 opacity-70 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`New page in ${workspaceName}`}
        title={state && !state.ok ? state.error.message : "New page"}
        data-testid="sidebar-new-page"
      >
        <PlusIcon />
      </button>
    </form>
  );
}

function SidebarSignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function signOut() {
    setPending(true);
    // Deletes the session row server-side and clears the cookie (R1.5, AC-07).
    await authClient.signOut();
    router.replace("/sign-in");
    router.refresh();
  }
  return (
    <button
      type="button"
      onClick={signOut}
      disabled={pending}
      className="ui-icon-button"
      aria-label="Sign out"
      title="Sign out"
      data-testid="sign-out"
    >
      <SignOutIcon />
    </button>
  );
}
