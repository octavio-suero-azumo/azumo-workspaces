"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { formatDateOnly, useBrowserNow, useBrowserTimeZone } from "@/components/local-time";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "@/components/nav-icons";
import { TopBar } from "@/components/top-bar";
import { Dialog } from "@/components/ui/dialog";
import { datesBetween, dayKeyInZone, type EventView, monthGrid, shiftMonth } from "@/lib/calendar";
import { DEFAULT_PAGE_ICON, DEFAULT_WORKSPACE_ICON, displayIcon } from "@/lib/icons";
import { createEventAction, deleteEventAction, updateEventAction } from "./actions";

/*
 * Month calendar (E4). Desktop: a 6×7 table; mobile (< 768 px): an agenda of
 * the selected month. All-day events are calendar dates shown as-is (never
 * converted). Timed events are placed on the viewer's local days; the zone
 * in use is always shown. Only Owner/Editor see create/edit/delete controls;
 * the server enforces them regardless.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Props {
  month: string;
  workspaces: { id: string; name: string; icon: string | null }[];
  workspace: { id: string; name: string; icon: string | null };
  canWrite: boolean;
  events: EventView[];
  pages: { id: string; title: string; icon: string | null }[];
}

type DialogState = { mode: "create"; date: string } | { mode: "view"; event: EventView } | null;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** ISO instant → `YYYY-MM-DDTHH:MM` in the browser's local zone (for datetime-local inputs). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Days (local) an event covers, as `YYYY-MM-DD`. */
function eventDays(event: EventView, zone: string): string[] {
  if (event.allDay) return datesBetween(event.startDate!, event.endDate!);
  const start = dayKeyInZone(new Date(event.startAt!), zone);
  const end = dayKeyInZone(new Date(new Date(event.endAt!).getTime() - 1), zone);
  return datesBetween(start, end < start ? start : end);
}

function timeLabel(event: EventView, zone: string): string {
  if (event.allDay) return "All day";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone: zone }).format(new Date(event.startAt!));
}

function whenLabel(event: EventView, zone: string): string {
  if (event.allDay) {
    return event.startDate === event.endDate
      ? `${formatDateOnly(event.startDate!, { weekday: "long" })} · All day`
      : `${formatDateOnly(event.startDate!)} – ${formatDateOnly(event.endDate!)} · All day`;
  }
  const format = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  });
  return `${format.format(new Date(event.startAt!))} – ${format.format(new Date(event.endAt!))}`;
}

export function CalendarView({ month, workspaces, workspace, canWrite, events, pages }: Props) {
  const router = useRouter();
  const zone = useBrowserTimeZone();
  const now = useBrowserNow();
  const [dialog, setDialog] = useState<DialogState>(null);
  const grid = useMemo(() => monthGrid(month), [month]);
  const today = zone && now !== null ? dayKeyInZone(new Date(now), zone) : null;

  const byDay = useMemo(() => {
    const map = new Map<string, EventView[]>();
    if (!zone) return map;
    for (const event of events) {
      for (const day of eventDays(event, zone)) {
        const list = map.get(day) ?? [];
        list.push(event);
        map.set(day, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.allDay === b.allDay ? (a.startAt ?? "").localeCompare(b.startAt ?? "") : a.allDay ? -1 : 1));
    }
    return map;
  }, [events, zone]);

  const monthLabel = formatDateOnly(`${month}-01`, { day: undefined, month: "long", year: "numeric" });
  const href = (m: string) => `/calendar?ws=${workspace.id}&m=${m}`;
  const monthDays = grid.filter((day) => day.startsWith(month));

  return (
    <>
      <TopBar crumbs={[{ label: "Calendar" }, { label: workspace.name, icon: displayIcon(workspace.icon, DEFAULT_WORKSPACE_ICON) }]} />
      <main id="main-content" className="flex w-full flex-col gap-4 px-4 pb-24 pt-4 md:px-8">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold" data-testid="calendar-month">
            {monthLabel}
          </h1>
          <div className="flex items-center gap-1">
            <Link href={href(shiftMonth(month, -1))} className="ui-icon-button" aria-label="Previous month" data-testid="calendar-prev">
              <ChevronLeftIcon />
            </Link>
            <button
              type="button"
              className="ui-button-secondary min-h-7 px-2"
              onClick={() => router.push(href((today ?? new Date().toISOString().slice(0, 10)).slice(0, 7)))}
              data-testid="calendar-today"
            >
              Today
            </button>
            <Link href={href(shiftMonth(month, 1))} className="ui-icon-button" aria-label="Next month" data-testid="calendar-next">
              <ChevronRightIcon />
            </Link>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Workspace</span>
            <select
              className="ui-select w-auto max-w-56"
              value={workspace.id}
              onChange={(event) => router.push(`/calendar?ws=${event.target.value}&m=${month}`)}
              data-testid="calendar-workspace"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {displayIcon(w.icon, DEFAULT_WORKSPACE_ICON)} {w.name}
                </option>
              ))}
            </select>
          </label>
          {canWrite ? (
            <button
              type="button"
              className="ui-button-primary ml-auto"
              onClick={() => setDialog({ mode: "create", date: today && today.startsWith(month) ? today : `${month}-01` })}
              data-testid="calendar-new-event"
            >
              <PlusIcon />
              New event
            </button>
          ) : (
            <p className="ml-auto text-xs text-muted">View only: Owners and Editors can add events.</p>
          )}
        </header>
        <p className="text-xs text-muted" data-testid="calendar-zone">
          {zone ? `Times are shown in ${zone}. All-day events keep their date in every time zone.` : "Loading time zone…"}
        </p>

        {/* Desktop month grid */}
        <table className="hidden w-full table-fixed border-collapse md:table" data-testid="calendar-grid">
          <caption className="sr-only">
            {monthLabel}, {workspace.name}
          </caption>
          <thead>
            <tr>
              {WEEKDAYS.map((day) => (
                <th key={day} scope="col" className="pb-1 text-left text-xs font-medium text-muted">
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }, (_, week) => (
              <tr key={week}>
                {grid.slice(week * 7, week * 7 + 7).map((day) => {
                  const inMonth = day.startsWith(month);
                  const isToday = day === today;
                  const list = byDay.get(day) ?? [];
                  return (
                    <td
                      key={day}
                      className={`h-28 border border-border p-1 align-top ${inMonth ? "" : "bg-sidebar"}`}
                      data-testid="calendar-day"
                      data-date={day}
                    >
                      <div className="flex items-center justify-between">
                        <span
                          className={`flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs ${
                            isToday ? "bg-[var(--today)] font-semibold text-white" : inMonth ? "text-fg" : "text-muted"
                          }`}
                          aria-current={isToday ? "date" : undefined}
                        >
                          {Number(day.slice(8))}
                        </span>
                        {canWrite ? (
                          <button
                            type="button"
                            className="ui-icon-button h-6 w-6 opacity-0 hover:opacity-100 focus-visible:opacity-100"
                            aria-label={`Add event on ${formatDateOnly(day)}`}
                            onClick={() => setDialog({ mode: "create", date: day })}
                          >
                            <PlusIcon width={12} height={12} />
                          </button>
                        ) : null}
                      </div>
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {list.slice(0, 3).map((event) => (
                          <li key={event.id}>
                            <button
                              type="button"
                              onClick={() => setDialog({ mode: "view", event })}
                              className={`w-full truncate rounded px-1 py-0.5 text-left text-xs ${
                                event.allDay ? "bg-[rgba(35,131,226,0.18)] text-fg" : "text-fg hover:bg-hover"
                              }`}
                              title={event.title}
                              data-testid="calendar-event"
                            >
                              {event.allDay || !zone ? "" : `${timeLabel(event, zone)} `}
                              {event.title}
                            </button>
                          </li>
                        ))}
                        {list.length > 3 ? (
                          <li className="px-1 text-xs text-muted">+{list.length - 3} more (see the agenda on a small screen or zoom out)</li>
                        ) : null}
                      </ul>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        {/* Mobile agenda for the selected month */}
        <section className="md:hidden" aria-label={`Agenda for ${monthLabel}`} data-testid="calendar-agenda">
          {monthDays.filter((day) => (byDay.get(day) ?? []).length > 0).length === 0 ? (
            <p className="text-sm text-muted">No events this month.</p>
          ) : (
            <ol className="flex flex-col gap-4">
              {monthDays
                .filter((day) => (byDay.get(day) ?? []).length > 0)
                .map((day) => (
                  <li key={day}>
                    <h2 className={`text-sm font-semibold ${day === today ? "text-[var(--today)]" : ""}`}>
                      {formatDateOnly(day, { weekday: "long" })}
                      {day === today ? " · Today" : ""}
                    </h2>
                    <ul className="mt-1 flex flex-col divide-y divide-border">
                      {(byDay.get(day) ?? []).map((event) => (
                        <li key={event.id}>
                          <button
                            type="button"
                            className="flex w-full min-w-0 items-center gap-2 py-2 text-left"
                            onClick={() => setDialog({ mode: "view", event })}
                            data-testid="calendar-agenda-event"
                          >
                            <span className="w-16 shrink-0 text-xs text-muted">{zone ? timeLabel(event, zone) : ""}</span>
                            <span className="truncate text-sm">{event.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
            </ol>
          )}
          {canWrite ? (
            <button
              type="button"
              className="ui-button-secondary mt-4"
              onClick={() => setDialog({ mode: "create", date: today && today.startsWith(month) ? today : `${month}-01` })}
            >
              <PlusIcon />
              Add event
            </button>
          ) : null}
        </section>
      </main>

      {dialog ? (
        <EventDialog
          key={dialog.mode === "view" ? dialog.event.id : `new-${dialog.date}`}
          state={dialog}
          zone={zone}
          workspaceId={workspace.id}
          canWrite={canWrite}
          pages={pages}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function EventDialog({
  state,
  zone,
  workspaceId,
  canWrite,
  pages,
  onClose,
  onSaved,
}: {
  state: NonNullable<DialogState>;
  zone: string | null;
  workspaceId: string;
  canWrite: boolean;
  pages: { id: string; title: string; icon: string | null }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = state.mode === "view" ? state.event : null;
  const [editing, setEditing] = useState(state.mode === "create");
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [allDay, setAllDay] = useState(existing ? existing.allDay : true);
  const baseDate = state.mode === "create" ? state.date : (existing?.startDate ?? (existing?.startAt ? toLocalInput(existing.startAt).slice(0, 10) : ""));
  const [startDate, setStartDate] = useState(existing?.startDate ?? baseDate);
  const [endDate, setEndDate] = useState(existing?.endDate ?? baseDate);
  const [startLocal, setStartLocal] = useState(existing?.startAt ? toLocalInput(existing.startAt) : `${baseDate}T09:00`);
  const [endLocal, setEndLocal] = useState(existing?.endAt ? toLocalInput(existing.endAt) : `${baseDate}T10:00`);
  const [pageId, setPageId] = useState(existing?.page?.id ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const fields: Record<string, unknown> = { title, description, allDay, pageId: pageId || null };
    if (allDay) {
      fields.startDate = startDate;
      fields.endDate = endDate;
    } else {
      const start = new Date(startLocal);
      const end = new Date(endLocal);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        setError("Enter valid dates.");
        return;
      }
      fields.startAt = start.toISOString();
      fields.endAt = end.toISOString();
      fields.timeZone = zone ?? "UTC";
    }
    startTransition(async () => {
      const result = existing
        ? await updateEventAction({ eventId: existing.id, ...fields })
        : await createEventAction({ workspaceId, ...fields });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onSaved();
    });
  }

  function remove() {
    if (!existing) return;
    startTransition(async () => {
      const result = await deleteEventAction({ eventId: existing.id });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onSaved();
    });
  }

  const titleText = state.mode === "create" ? "New event" : editing ? "Edit event" : (existing?.title ?? "Event");

  return (
    <Dialog open onClose={onClose} title={titleText} size="md" testId="event-dialog">
      {!editing && existing ? (
        <div className="flex flex-col gap-3 text-sm">
          <p data-testid="event-when">{zone ? whenLabel(existing, zone) : ""}</p>
          {!existing.allDay && existing.timeZone && zone && existing.timeZone !== zone ? (
            <p className="text-xs text-muted">Created in {existing.timeZone}; shown in {zone}.</p>
          ) : null}
          {existing.description ? <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{existing.description}</p> : null}
          {existing.page ? (
            <p>
              Related page:{" "}
              <Link href={`/p/${existing.page.id}`} className="text-link hover:underline">
                {displayIcon(existing.page.icon, DEFAULT_PAGE_ICON)} {existing.page.title}
              </Link>
            </p>
          ) : null}
          {canWrite ? (
            confirmDelete ? (
              <div role="alertdialog" aria-label="Confirm delete" className="flex flex-wrap items-center gap-2 rounded-md bg-hover p-3">
                <span>Delete this event?</span>
                <button type="button" className="ui-button-danger" onClick={remove} disabled={pending} autoFocus>
                  {pending ? "Deleting…" : "Delete event"}
                </button>
                <button type="button" className="ui-button-secondary" onClick={() => setConfirmDelete(false)} disabled={pending}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex justify-end gap-2">
                <button type="button" className="ui-button-danger" onClick={() => setConfirmDelete(true)} data-testid="event-delete">
                  Delete
                </button>
                <button type="button" className="ui-button-primary" onClick={() => setEditing(true)} data-testid="event-edit">
                  Edit
                </button>
              </div>
            )
          ) : null}
          {error ? (
            <p role="alert" className="text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3" aria-label={titleText}>
          <label className="ui-label">
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} className="ui-input" autoFocus />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            All day
          </label>
          {allDay ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="ui-label">
                Starts
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required className="ui-input" />
              </label>
              <label className="ui-label">
                Ends
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required className="ui-input" />
              </label>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="ui-label">
                Starts
                <input type="datetime-local" value={startLocal} onChange={(e) => setStartLocal(e.target.value)} required className="ui-input" />
              </label>
              <label className="ui-label">
                Ends
                <input type="datetime-local" value={endLocal} onChange={(e) => setEndLocal(e.target.value)} required className="ui-input" />
              </label>
              <p className="text-xs text-muted sm:col-span-2">Time zone: {zone ?? "…"}</p>
            </div>
          )}
          <label className="ui-label">
            Description (optional)
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} className="ui-textarea" />
          </label>
          <label className="ui-label">
            Related page (optional)
            <select value={pageId} onChange={(e) => setPageId(e.target.value)} className="ui-select">
              <option value="">None</option>
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {displayIcon(p.icon, DEFAULT_PAGE_ICON)} {p.title}
                </option>
              ))}
            </select>
          </label>
          {error ? (
            <p role="alert" className="text-sm text-danger" data-testid="event-error">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button type="button" className="ui-button-secondary" onClick={existing ? () => setEditing(false) : onClose} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className="ui-button-primary" disabled={pending} data-testid="event-save">
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
