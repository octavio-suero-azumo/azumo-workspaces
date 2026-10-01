import type { Metadata } from "next";
import Link from "next/link";
import { LocalDateTime } from "@/components/local-time";
import { TopBar } from "@/components/top-bar";
import { DEFAULT_PAGE_ICON, DEFAULT_WORKSPACE_ICON, displayIcon } from "@/lib/icons";
import { can, canCreateWorkspace } from "@/server/authz/permissions";
import { listUpcomingEvents } from "@/server/data/events";
import { countLivePages, listRecentPages } from "@/server/data/home";
import { listMyWorkspaces } from "@/server/data/workspaces";
import { requirePageContext } from "@/server/render-guards";
import { HomeActions, UpcomingEvents } from "./home-client";

export const metadata: Metadata = { title: "Home · Azumo Workspaces" };

const ROLE_LABEL: Readonly<Record<string, string>> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

/**
 * Home (E3): real, persisted data only — my workspaces, my live pages ordered
 * by last edit ("Recently edited", never "viewed"), my upcoming events, and
 * the create actions my roles allow. Everything goes through my memberships,
 * so trashed pages and other people's workspaces never appear (AC-45).
 */
export default async function Home() {
  const { session, ctx } = await requirePageContext();
  const [workspaces, recent, counts, upcoming] = await Promise.all([
    listMyWorkspaces(ctx),
    listRecentPages(ctx, 10),
    countLivePages(ctx),
    listUpcomingEvents(ctx, { today: new Date().toISOString().slice(0, 10), limit: 20 }),
  ]);
  const firstName = session.user.name.split(" ")[0] || session.user.name;
  const pageTargets = workspaces.filter((w) => can(w.role, "page.create"));

  return (
    <>
      <TopBar crumbs={[{ label: "Home" }]} />
      <main id="main-content" className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-6 pb-24 pt-6">
        <header className="flex flex-col gap-4">
          <h1 className="text-3xl font-bold">Welcome back, {firstName}</h1>
          <HomeActions
            canCreateWorkspace={canCreateWorkspace(session)}
            pageTargets={pageTargets.map((w) => ({ id: w.id, name: w.name, icon: w.icon }))}
          />
        </header>

        <section aria-labelledby="home-workspaces" className="flex flex-col gap-3">
          <h2 id="home-workspaces" className="ui-section-title">
            Workspaces
          </h2>
          {workspaces.length === 0 ? (
            <div className="ui-card p-6 text-sm text-muted" data-testid="empty-state">
              <p className="font-medium text-fg">No workspaces yet</p>
              <p className="mt-1">You are not a member of any workspace. Create one, or ask a workspace Owner to add you.</p>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="home-workspaces">
              {workspaces.map((w) => (
                <li key={w.id}>
                  <Link href={`/w/${w.id}`} className="ui-card flex h-full flex-col gap-2 p-4 hover:bg-hover" data-testid="home-workspace">
                    <span aria-hidden="true" className="text-2xl">
                      {displayIcon(w.icon, DEFAULT_WORKSPACE_ICON)}
                    </span>
                    <span className="truncate font-medium" title={w.name}>
                      {w.name}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted">
                      <span className="ui-badge">{ROLE_LABEL[w.role] ?? w.role}</span>
                      {counts[w.id] ?? 0} {(counts[w.id] ?? 0) === 1 ? "page" : "pages"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="home-recent" className="flex flex-col gap-3">
          <h2 id="home-recent" className="ui-section-title">
            Recently edited
          </h2>
          {recent.length === 0 ? (
            <p className="text-sm text-muted" data-testid="home-no-recent">
              No pages yet.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border" data-testid="home-recent">
              {recent.map((p) => (
                <li key={p.id} data-testid="home-recent-page">
                  <Link href={`/w/${p.workspaceId}/p/${p.id}`} className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 hover:bg-hover">
                    <span aria-hidden="true" className="shrink-0 text-lg">
                      {displayIcon(p.icon, DEFAULT_PAGE_ICON)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium text-fg" title={p.title}>
                        {p.title}
                      </span>
                      <span className="truncate text-xs text-muted">
                        {displayIcon(p.workspaceIcon, DEFAULT_WORKSPACE_ICON)} {p.workspaceName} ·{" "}
                        <LocalDateTime iso={p.updatedAt.toISOString()} prefix="Edited" />
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="home-events" className="flex flex-col gap-3">
          <h2 id="home-events" className="ui-section-title">
            Upcoming events
          </h2>
          <UpcomingEvents
            events={upcoming.map((e) => ({
              id: e.id,
              title: e.title,
              allDay: e.allDay,
              startDate: e.startDate,
              endDate: e.endDate,
              startAt: e.startAt,
              endAt: e.endAt,
              workspaceId: e.workspaceId,
              workspaceName: e.workspaceName,
              workspaceIcon: e.workspaceIcon,
            }))}
          />
        </section>
      </main>
    </>
  );
}
