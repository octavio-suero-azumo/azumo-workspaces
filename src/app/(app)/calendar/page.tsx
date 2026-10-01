import type { Metadata } from "next";
import { TopBar } from "@/components/top-bar";
import { isMonthKey, monthGrid } from "@/lib/calendar";
import { can } from "@/server/authz/permissions";
import { listEventsInRange, listLinkablePages } from "@/server/data/events";
import { listMyWorkspaces } from "@/server/data/workspaces";
import { orNotFound, requirePageContext } from "@/server/render-guards";
import { CalendarView } from "./calendar-view";

export const metadata: Metadata = { title: "Calendar · Azumo Workspaces" };

/**
 * Calendar (E4): one workspace at a time, month view. The workspace selector
 * lists only MY workspaces; a `ws` that is not mine falls back to my first
 * workspace (never reveals anything about it). Events and linkable pages are
 * read through `authorize()` (`event.view`). Owner/Editor may create, edit
 * and delete; Viewers read.
 */
export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  const { ws, m } = await searchParams;
  const { ctx } = await requirePageContext();
  const workspaces = await listMyWorkspaces(ctx);
  const month = typeof m === "string" && isMonthKey(m) ? m : new Date().toISOString().slice(0, 7);

  if (workspaces.length === 0) {
    return (
      <>
        <TopBar crumbs={[{ label: "Calendar" }]} />
        <main id="main-content" className="mx-auto w-full max-w-3xl px-6 pt-8">
          <h1 className="text-3xl font-bold">Calendar</h1>
          <p className="mt-3 text-sm text-muted" data-testid="calendar-empty">
            Join or create a workspace to use its calendar.
          </p>
        </main>
      </>
    );
  }

  const selected = workspaces.find((w) => w.id === ws) ?? workspaces[0];
  const grid = monthGrid(month);
  const [events, pages] = await Promise.all([
    orNotFound(listEventsInRange(ctx, { workspaceId: selected.id, from: grid[0], to: grid[grid.length - 1] })),
    orNotFound(listLinkablePages(ctx, selected.id)),
  ]);

  return (
    <CalendarView
      key={`${selected.id}-${month}`}
      month={month}
      workspaces={workspaces.map((w) => ({ id: w.id, name: w.name, icon: w.icon }))}
      workspace={{ id: selected.id, name: selected.name, icon: selected.icon }}
      canWrite={can(selected.role, "event.create")}
      events={events}
      pages={pages}
    />
  );
}
