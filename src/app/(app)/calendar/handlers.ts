import { revalidatePath } from "next/cache";
import type { ActionContext } from "@/server/action";
import { getDataContext } from "@/server/data/context";
import { createEvent, deleteEvent, updateEvent } from "@/server/data/events";

/**
 * Calendar server-action handlers (PRD §12 E4). Plain module, exposed only
 * through `action(handler)` in `actions.ts`. The data layer authorizes every
 * call (`event.create/edit/delete`) and derives the workspace from the event
 * row or the authorize target, never from client data alone.
 */

const EVENT_KEYS = [
  "title",
  "description",
  "allDay",
  "startDate",
  "endDate",
  "startAt",
  "endAt",
  "timeZone",
  "pageId",
] as const;

function pick(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof input !== "object" || input === null) return result;
  for (const key of keys) {
    if (Object.hasOwn(input, key)) result[key] = (input as Record<string, unknown>)[key];
  }
  return result;
}

function revalidateCalendar() {
  revalidatePath("/calendar");
  revalidatePath("/", "layout");
}

export async function createEventHandler(session: ActionContext, input: unknown) {
  const ctx = await getDataContext(session);
  const created = await createEvent(ctx, pick(input, ["workspaceId", ...EVENT_KEYS]));
  revalidateCalendar();
  return created;
}

export async function updateEventHandler(session: ActionContext, input: unknown) {
  const ctx = await getDataContext(session);
  const updated = await updateEvent(ctx, pick(input, ["eventId", ...EVENT_KEYS]));
  revalidateCalendar();
  return updated;
}

export async function deleteEventHandler(session: ActionContext, input: unknown) {
  const ctx = await getDataContext(session);
  const deleted = await deleteEvent(ctx, pick(input, ["eventId"]));
  revalidateCalendar();
  return deleted;
}
