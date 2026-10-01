"use server";

import { action } from "@/server/action";
import { createEventHandler, deleteEventHandler, updateEventHandler } from "./handlers";

/** Calendar server actions (PRD §12 E4). Every export is `action(handler)` (AC-01). */

export const createEventAction = action(createEventHandler);

export const updateEventAction = action(updateEventHandler);

export const deleteEventAction = action(deleteEventHandler);
