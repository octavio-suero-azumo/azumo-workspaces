/**
 * Calendar date rules (scope expansion 2026-10-01). Pure functions shared by
 * the server (validation) and the client (month grid, agenda).
 *
 * Time-zone policy:
 * - ALL-DAY events store calendar dates (`YYYY-MM-DD`, end date INCLUSIVE).
 *   They are never converted between time zones, so an all-day event stays on
 *   the same day for every viewer, wherever they are.
 * - TIMED events store UTC instants plus the IANA time zone the author used
 *   when saving. Each viewer sees the times converted to their browser's time
 *   zone, and the UI always labels which zone it is showing.
 */

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written as `YYYY-MM-DD` (rejects 2026-02-30). */
export function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_ONLY_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900 || year > 2999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** `YYYY-MM-DD` → UTC midnight of that date (for arithmetic only). */
function dateOnlyToUtc(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** UTC date → `YYYY-MM-DD` of its UTC calendar day. */
export function utcDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Add whole days to a `YYYY-MM-DD` date (never touches local time zones). */
export function addDays(value: string, days: number): string {
  const date = dateOnlyToUtc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateOnly(date);
}

/** True when `timeZone` is an IANA zone this runtime knows (e.g. `Europe/Madrid`). */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Calendar date (`YYYY-MM-DD`) of an instant as seen in `timeZone`. */
export function dayKeyInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** `YYYY-MM` of a date-only string. */
export function monthKey(value: string): string {
  return value.slice(0, 7);
}

/** True for `YYYY-MM` with a real month. */
export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}$/.test(value) && isDateOnly(`${value}-01`);
}

/** First day of the month after / before `YYYY-MM`. */
export function shiftMonth(month: string, delta: number): string {
  const [year, monthIndex] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthIndex - 1 + delta, 1));
  return utcDateOnly(date).slice(0, 7);
}

/**
 * The 6×7 grid of dates shown for a month (weeks start on Monday). Returns
 * `YYYY-MM-DD` strings; the first and last entries define the visible range.
 */
export function monthGrid(month: string): string[] {
  const first = dateOnlyToUtc(`${month}-01`);
  // getUTCDay: 0 = Sunday … 6 = Saturday. Monday-first offset:
  const offset = (first.getUTCDay() + 6) % 7;
  const start = addDays(`${month}-01`, -offset);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

/** Inclusive list of dates from `start` to `end` (both `YYYY-MM-DD`), capped for safety. */
export function datesBetween(start: string, end: string, cap = 366): string[] {
  const result: string[] = [];
  let current = start;
  while (current <= end && result.length < cap) {
    result.push(current);
    current = addDays(current, 1);
  }
  return result;
}

/** A calendar event as the server returns it to the UI (no internal columns). */
export interface EventView {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  allDay: boolean;
  /** All-day: `YYYY-MM-DD` (inclusive). Null for timed events. */
  startDate: string | null;
  endDate: string | null;
  /** Timed: ISO instants. Null for all-day events. */
  startAt: string | null;
  endAt: string | null;
  timeZone: string | null;
  /** Live related page of the same workspace, or null (missing, trashed or unlinked). */
  page: { id: string; title: string; icon: string | null } | null;
}

export const EVENT_TITLE_MAX = 200;
export const EVENT_DESCRIPTION_MAX = 2000;
/** Longest event span accepted (all-day or timed), in days. */
export const EVENT_MAX_SPAN_DAYS = 366;
