"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { createPageAction } from "@/app/(app)/w/[workspaceId]/p/actions";
import { CreateWorkspaceDialog } from "@/components/create-workspace-dialog";
import { formatDateOnly, useBrowserNow, useBrowserTimeZone } from "@/components/local-time";
import { CalendarIcon, PlusIcon } from "@/components/nav-icons";
import { Menu } from "@/components/ui/menu";
import { dayKeyInZone } from "@/lib/calendar";
import { DEFAULT_WORKSPACE_ICON, displayIcon } from "@/lib/icons";

/*
 * Client parts of Home (E3): create actions (only where the role allows) and
 * the upcoming-events list, which needs the viewer's time zone to decide what
 * "upcoming" and "today" mean.
 */

export interface HomeWorkspaceOption {
  id: string;
  name: string;
  icon: string | null;
}

export function HomeActions({
  canCreateWorkspace,
  pageTargets,
}: {
  canCreateWorkspace: boolean;
  pageTargets: HomeWorkspaceOption[];
}) {
  const [creating, setCreating] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function newPage(workspaceId: string) {
    setError(null);
    const form = new FormData();
    form.set("workspaceId", workspaceId);
    form.set("title", "Untitled");
    startTransition(async () => {
      const result = await createPageAction(null, form);
      if (result && !result.ok) setError(result.error.message);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {pageTargets.length > 0 ? (
        <Menu
          label="New page in…"
          align="start"
          testId="home-new-page"
          triggerClassName="ui-button-primary"
          trigger={
            <>
              <PlusIcon />
              <span>{pending ? "Creating…" : "New page"}</span>
            </>
          }
          sections={[
            {
              key: "targets",
              label: "Create in",
              items: pageTargets.map((w) => ({
                key: w.id,
                label: w.name,
                icon: <span>{displayIcon(w.icon, DEFAULT_WORKSPACE_ICON)}</span>,
                onSelect: () => newPage(w.id),
              })),
            },
          ]}
        />
      ) : null}
      {canCreateWorkspace ? (
        <button type="button" className="ui-button-secondary" onClick={() => setCreating(true)} data-testid="home-new-workspace">
          <PlusIcon />
          New workspace
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="basis-full text-sm text-danger">
          {error}
        </p>
      ) : null}
      <CreateWorkspaceDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

export interface HomeEvent {
  id: string;
  title: string;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  startAt: string | null;
  endAt: string | null;
  workspaceId: string;
  workspaceName: string;
  workspaceIcon: string | null;
}

/** Upcoming events in the viewer's zone: ended events are dropped, at most 10 shown (DP18). */
export function UpcomingEvents({ events }: { events: HomeEvent[] }) {
  const zone = useBrowserTimeZone();
  const now = useBrowserNow();
  const visible = useMemo(() => {
    if (!zone || now === null) return null;
    const today = dayKeyInZone(new Date(now), zone);
    return events
      .filter((event) => (event.allDay ? (event.endDate ?? "") >= today : new Date(event.endAt ?? 0).getTime() >= now))
      .slice(0, 10);
  }, [events, zone, now]);

  if (!visible) {
    return <p className="text-sm text-muted">Loading events…</p>;
  }
  if (visible.length === 0) {
    return (
      <p className="text-sm text-muted" data-testid="home-no-events">
        No upcoming events. Add one from the <Link href="/calendar" className="text-link underline-offset-2 hover:underline">calendar</Link>.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border" data-testid="home-events">
      {visible.map((event) => {
        const day = event.allDay ? event.startDate! : dayKeyInZone(new Date(event.startAt!), zone!);
        const when = event.allDay
          ? event.startDate === event.endDate
            ? `${formatDateOnly(event.startDate!)} · All day`
            : `${formatDateOnly(event.startDate!)} – ${formatDateOnly(event.endDate!)} · All day`
          : new Intl.DateTimeFormat(undefined, {
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              timeZone: zone!,
            }).format(new Date(event.startAt!));
        return (
          <li key={event.id} data-testid="home-event">
            <Link
              href={`/calendar?ws=${event.workspaceId}&m=${day.slice(0, 7)}`}
              className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 hover:bg-hover"
            >
              <CalendarIcon className="shrink-0 text-muted" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-fg">{event.title}</span>
                <span className="truncate text-xs text-muted">
                  {when} · {displayIcon(event.workspaceIcon, DEFAULT_WORKSPACE_ICON)} {event.workspaceName}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
