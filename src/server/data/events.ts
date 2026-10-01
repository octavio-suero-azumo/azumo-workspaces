import { and, asc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  addDays,
  EVENT_DESCRIPTION_MAX,
  EVENT_MAX_SPAN_DAYS,
  EVENT_TITLE_MAX,
  isDateOnly,
  isTimeZone,
  type EventView,
} from "@/lib/calendar";
import { authorize } from "@/server/authz/authorize";
import { calendarEvent, membership, page, workspace } from "@/server/db/schema";
import { NotFoundError, ValidationError } from "@/server/errors";
import { isUuid } from "./access";
import type { DataContext } from "./context";

/**
 * Calendar events (scope expansion E4, 2026-10-01; PRD §12, AC-46–AC-48).
 *
 * - Every member may view (`event.view`); Owner/Editor create, edit, delete.
 *   Non-members get 404. The workspace always comes from the event row (for
 *   edit/delete) or is the authorize target (for create/list).
 * - Time zones (see src/lib/calendar.ts): all-day events are calendar DATES
 *   and are never converted; timed events are UTC instants + the author's IANA
 *   zone, shown in each viewer's own zone.
 * - Related page (optional): must be a LIVE page of the SAME workspace,
 *   otherwise one generic 400 (no hint whether a foreign page exists). The
 *   composite FK makes a cross-workspace link impossible at the DB level.
 *   A link to a page that is now in Trash is hidden when reading (DP14) and
 *   shows again after Restore; a Move clears it (page-transfer.ts).
 */

export type { EventView };

export interface UpcomingEvent extends EventView {
  workspaceName: string;
  workspaceIcon: string | null;
}

export const INVALID_EVENT_PAGE_MESSAGE = "Choose a page from this workspace.";
export const EVENT_TITLE_REQUIRED_MESSAGE = "Event title is required.";
export const EVENT_TITLE_TOO_LONG_MESSAGE = `Event title must be at most ${EVENT_TITLE_MAX} characters.`;
export const EVENT_DESCRIPTION_TOO_LONG_MESSAGE = `Description must be at most ${EVENT_DESCRIPTION_MAX} characters.`;
export const EVENT_DATES_MESSAGE = "Enter valid dates.";
export const EVENT_END_BEFORE_START_MESSAGE = "The end must be after the start.";
export const EVENT_SPAN_MESSAGE = `An event can last at most ${EVENT_MAX_SPAN_DAYS} days.`;
export const EVENT_TIME_ZONE_MESSAGE = "Unknown time zone.";

const codePoints = (value: string) => Array.from(value).length;

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && Object.hasOwn(input, key)
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

interface EventFields {
  title: string;
  description: string | null;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  startAt: Date | null;
  endAt: Date | null;
  timeZone: string | null;
  pageId: string | null;
}

/** Strict ISO-8601 instant with an explicit offset or Z (what the browser sends). */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function parseInstant(raw: unknown): Date {
  if (typeof raw !== "string" || !ISO_INSTANT_RE.test(raw)) throw new ValidationError(EVENT_DATES_MESSAGE);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new ValidationError(EVENT_DATES_MESSAGE);
  const year = date.getUTCFullYear();
  if (year < 1900 || year > 2999) throw new ValidationError(EVENT_DATES_MESSAGE);
  return date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Validate and normalize the event fields (everything except authorization and the page check). */
export function parseEventFields(input: unknown): EventFields {
  const rawTitle = field(input, "title");
  if (typeof rawTitle !== "string" || rawTitle.trim().length === 0) throw new ValidationError(EVENT_TITLE_REQUIRED_MESSAGE);
  const title = rawTitle.trim();
  if (codePoints(title) > EVENT_TITLE_MAX) throw new ValidationError(EVENT_TITLE_TOO_LONG_MESSAGE);

  const rawDescription = field(input, "description");
  let description: string | null = null;
  if (rawDescription !== undefined && rawDescription !== null) {
    if (typeof rawDescription !== "string") throw new ValidationError("Invalid description.");
    const trimmed = rawDescription.trim();
    if (codePoints(trimmed) > EVENT_DESCRIPTION_MAX) throw new ValidationError(EVENT_DESCRIPTION_TOO_LONG_MESSAGE);
    description = trimmed.length > 0 ? trimmed : null;
  }

  const allDay = field(input, "allDay");
  if (typeof allDay !== "boolean") throw new ValidationError("Choose all-day or timed.");

  const rawPage = field(input, "pageId");
  let pageId: string | null = null;
  if (rawPage !== undefined && rawPage !== null && rawPage !== "") {
    if (!isUuid(rawPage)) throw new ValidationError(INVALID_EVENT_PAGE_MESSAGE);
    pageId = rawPage;
  }

  if (allDay) {
    const startDate = field(input, "startDate");
    const endDate = field(input, "endDate");
    if (!isDateOnly(startDate) || !isDateOnly(endDate)) throw new ValidationError(EVENT_DATES_MESSAGE);
    if (endDate < startDate) throw new ValidationError(EVENT_END_BEFORE_START_MESSAGE);
    if (addDays(startDate, EVENT_MAX_SPAN_DAYS) < endDate) throw new ValidationError(EVENT_SPAN_MESSAGE);
    return { title, description, allDay, startDate, endDate, startAt: null, endAt: null, timeZone: null, pageId };
  }

  const startAt = parseInstant(field(input, "startAt"));
  const endAt = parseInstant(field(input, "endAt"));
  if (endAt.getTime() <= startAt.getTime()) throw new ValidationError(EVENT_END_BEFORE_START_MESSAGE);
  if (endAt.getTime() - startAt.getTime() > EVENT_MAX_SPAN_DAYS * DAY_MS) throw new ValidationError(EVENT_SPAN_MESSAGE);
  const timeZone = field(input, "timeZone");
  if (!isTimeZone(timeZone)) throw new ValidationError(EVENT_TIME_ZONE_MESSAGE);
  return { title, description, allDay, startDate: null, endDate: null, startAt, endAt, timeZone, pageId };
}

/** The linked page must be live and in `workspaceId`; anything else is the same 400. */
async function assertLinkablePage(ctx: DataContext, pageId: string | null, workspaceId: string): Promise<void> {
  if (pageId === null) return;
  const [row] = await ctx.db
    .select({ id: page.id })
    .from(page)
    .where(and(eq(page.id, pageId), eq(page.workspaceId, workspaceId), isNull(page.deletedAt)))
    .limit(1);
  if (!row) throw new ValidationError(INVALID_EVENT_PAGE_MESSAGE);
}

const eventColumns = {
  id: calendarEvent.id,
  workspaceId: calendarEvent.workspaceId,
  title: calendarEvent.title,
  description: calendarEvent.description,
  allDay: calendarEvent.allDay,
  startDate: calendarEvent.startDate,
  endDate: calendarEvent.endDate,
  startAt: calendarEvent.startAt,
  endAt: calendarEvent.endAt,
  timeZone: calendarEvent.timeZone,
  pageId: page.id,
  pageTitle: page.title,
  pageIcon: page.icon,
};

type EventRow = {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  startAt: Date | null;
  endAt: Date | null;
  timeZone: string | null;
  pageId: string | null;
  pageTitle: string | null;
  pageIcon: string | null;
};

function toView(row: EventRow): EventView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    description: row.description,
    allDay: row.allDay,
    startDate: row.startDate,
    endDate: row.endDate,
    startAt: row.startAt ? row.startAt.toISOString() : null,
    endAt: row.endAt ? row.endAt.toISOString() : null,
    timeZone: row.timeZone,
    page: row.pageId && row.pageTitle !== null ? { id: row.pageId, title: row.pageTitle, icon: row.pageIcon } : null,
  };
}

/** Live linked page of the SAME workspace only (trashed pages are not joined: DP14). */
const linkedLivePage = and(
  eq(page.id, calendarEvent.pageId),
  eq(page.workspaceId, calendarEvent.workspaceId),
  isNull(page.deletedAt),
);

/**
 * Events of one workspace that overlap the inclusive date range
 * [`from`, `to`] (`YYYY-MM-DD`). Timed events use a window widened by one
 * day on each side so every viewer's time zone is covered; the browser
 * places them on its own local days.
 */
export async function listEventsInRange(
  ctx: DataContext,
  input: { workspaceId: string; from: string; to: string },
): Promise<EventView[]> {
  const authorized = await authorize(ctx, { workspaceId: input.workspaceId }, "event.view");
  if (!isDateOnly(input.from) || !isDateOnly(input.to) || input.to < input.from) {
    throw new ValidationError(EVENT_DATES_MESSAGE);
  }
  const windowStart = new Date(`${addDays(input.from, -1)}T00:00:00Z`);
  const windowEnd = new Date(`${addDays(input.to, 2)}T00:00:00Z`);

  const rows = await ctx.db
    .select(eventColumns)
    .from(calendarEvent)
    .leftJoin(page, linkedLivePage)
    .where(
      and(
        eq(calendarEvent.workspaceId, authorized.workspaceId),
        or(
          and(eq(calendarEvent.allDay, true), lte(calendarEvent.startDate, input.to), gte(calendarEvent.endDate, input.from)),
          and(eq(calendarEvent.allDay, false), lte(calendarEvent.startAt, windowEnd), gte(calendarEvent.endAt, windowStart)),
        ),
      ),
    )
    .orderBy(asc(calendarEvent.startDate), asc(calendarEvent.startAt), asc(calendarEvent.title), asc(calendarEvent.id));
  return rows.map(toView);
}

/**
 * Upcoming events across ALL my workspaces (Home, DP18). `today` is the
 * viewer's local date when known; the server widens by a day so the browser
 * can drop events that already ended in its own zone.
 */
export async function listUpcomingEvents(
  ctx: DataContext,
  input: { today: string; limit?: number },
): Promise<UpcomingEvent[]> {
  const today = isDateOnly(input.today) ? input.today : new Date().toISOString().slice(0, 10);
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const allDayFrom = addDays(today, -1);
  const timedFrom = new Date(Date.now() - DAY_MS);

  const rows = await ctx.db
    .select({ ...eventColumns, workspaceName: workspace.name, workspaceIcon: workspace.icon })
    .from(calendarEvent)
    .innerJoin(
      membership,
      and(eq(membership.workspaceId, calendarEvent.workspaceId), eq(membership.userId, ctx.userId)),
    )
    .innerJoin(workspace, eq(workspace.id, calendarEvent.workspaceId))
    .leftJoin(page, linkedLivePage)
    .where(
      or(
        and(eq(calendarEvent.allDay, true), gte(calendarEvent.endDate, allDayFrom)),
        and(eq(calendarEvent.allDay, false), gte(calendarEvent.endAt, timedFrom)),
      ),
    )
    .orderBy(
      asc(sql`coalesce(${calendarEvent.startAt}, ${calendarEvent.startDate}::timestamptz)`),
      asc(calendarEvent.id),
    )
    .limit(limit + 10);
  return rows.map((row) => ({ ...toView(row), workspaceName: row.workspaceName, workspaceIcon: row.workspaceIcon }));
}

/** One event (any member). */
export async function getEvent(ctx: DataContext, input: { eventId: string }): Promise<EventView> {
  const authorized = await authorize(ctx, { eventId: input.eventId }, "event.view");
  const [row] = await ctx.db
    .select(eventColumns)
    .from(calendarEvent)
    .leftJoin(page, linkedLivePage)
    .where(and(eq(calendarEvent.id, authorized.resource.id), eq(calendarEvent.workspaceId, authorized.workspaceId)))
    .limit(1);
  if (!row) throw new NotFoundError();
  return toView(row);
}

/** Create an event (Owner, Editor). Input: `{ workspaceId, title, description?, allDay, … , pageId? }`. */
export async function createEvent(ctx: DataContext, input: unknown): Promise<EventView> {
  const workspaceId = field(input, "workspaceId");
  if (typeof workspaceId !== "string") throw new ValidationError("Invalid input.");
  const authorized = await authorize(ctx, { workspaceId }, "event.create");
  const fields = parseEventFields(input);
  await assertLinkablePage(ctx, fields.pageId, authorized.workspaceId);

  let created: { id: string } | undefined;
  try {
    [created] = await ctx.db
      .insert(calendarEvent)
      .values({ ...fields, workspaceId: authorized.workspaceId, createdBy: ctx.userId, updatedBy: ctx.userId })
      .returning({ id: calendarEvent.id });
  } catch (error) {
    if (isForeignKeyViolation(error)) throw new ValidationError(INVALID_EVENT_PAGE_MESSAGE);
    throw error;
  }
  return getEvent(ctx, { eventId: created!.id });
}

/** Edit an event (Owner, Editor). Input: `{ eventId, …fields }` (all fields, like create). */
export async function updateEvent(ctx: DataContext, input: unknown): Promise<EventView> {
  const eventId = field(input, "eventId");
  if (typeof eventId !== "string") throw new ValidationError("Invalid input.");
  const authorized = await authorize(ctx, { eventId }, "event.edit");
  const fields = parseEventFields(input);
  await assertLinkablePage(ctx, fields.pageId, authorized.workspaceId);

  let updated: { id: string }[];
  try {
    updated = await ctx.db
      .update(calendarEvent)
      .set({ ...fields, updatedBy: ctx.userId, updatedAt: sql`now()` })
      .where(and(eq(calendarEvent.id, authorized.resource.id), eq(calendarEvent.workspaceId, authorized.workspaceId)))
      .returning({ id: calendarEvent.id });
  } catch (error) {
    if (isForeignKeyViolation(error)) throw new ValidationError(INVALID_EVENT_PAGE_MESSAGE);
    throw error;
  }
  if (updated.length === 0) throw new NotFoundError();
  return getEvent(ctx, { eventId: authorized.resource.id });
}

/** Delete an event (Owner, Editor). Input: `{ eventId }`. */
export async function deleteEvent(ctx: DataContext, input: unknown): Promise<{ id: string; workspaceId: string }> {
  const eventId = field(input, "eventId");
  if (typeof eventId !== "string") throw new ValidationError("Invalid input.");
  const authorized = await authorize(ctx, { eventId }, "event.delete");
  const deleted = await ctx.db
    .delete(calendarEvent)
    .where(and(eq(calendarEvent.id, authorized.resource.id), eq(calendarEvent.workspaceId, authorized.workspaceId)))
    .returning({ id: calendarEvent.id });
  if (deleted.length === 0) throw new NotFoundError();
  return { id: authorized.resource.id, workspaceId: authorized.workspaceId };
}

/** Pages that can be linked from an event of this workspace (live only). */
export async function listLinkablePages(
  ctx: DataContext,
  workspaceId: string,
): Promise<{ id: string; title: string; icon: string | null }[]> {
  const authorized = await authorize(ctx, { workspaceId }, "event.view");
  return ctx.db
    .select({ id: page.id, title: page.title, icon: page.icon })
    .from(page)
    .where(and(eq(page.workspaceId, authorized.workspaceId), isNull(page.deletedAt)))
    .orderBy(asc(sql`lower(${page.title})`), asc(page.id));
}

function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === "23503") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
