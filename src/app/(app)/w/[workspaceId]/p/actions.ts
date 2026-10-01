"use server";

import { action } from "@/server/action";
import {
  createPageHandler,
  duplicatePageHandler,
  movePageHandler,
  restorePageHandler,
  savePageHandler,
  trashPageHandler,
  updatePageIconHandler,
  updatePagePresentationHandler,
} from "./handlers";

/**
 * Page server actions (T-10, T-11; PRD §12 E2, E5, E8–E10). Every export is
 * `action(handler)`: the session is resolved before the handler runs
 * (AC-01). Handlers live in `handlers.ts` (review RV-C-05 pattern).
 *
 * DP13: no hard-delete action is exported; Trash is the only removal path.
 */

export const createPageAction = action(createPageHandler);

export const savePageAction = action(savePageHandler);

export const updatePageIconAction = action(updatePageIconHandler);

export const updatePagePresentationAction = action(updatePagePresentationHandler);

export const duplicatePageAction = action(duplicatePageHandler);

export const movePageAction = action(movePageHandler);

export const trashPageAction = action(trashPageHandler);

export const restorePageAction = action(restorePageHandler);
