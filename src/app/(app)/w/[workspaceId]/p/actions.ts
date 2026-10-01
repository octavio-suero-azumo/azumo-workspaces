"use server";

import { action } from "@/server/action";
import { createPageHandler, deletePageHandler, savePageHandler } from "./handlers";

/**
 * Page server actions (T-10..T-12). Every export is `action(handler)`: the
 * session is resolved before the handler runs (AC-01). Handlers live in
 * `handlers.ts` (review RV-C-05 pattern).
 */

export const createPageAction = action(createPageHandler);

export const savePageAction = action(savePageHandler);

export const deletePageAction = action(deletePageHandler);
