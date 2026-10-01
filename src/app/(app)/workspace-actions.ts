"use server";

import { action } from "@/server/action";
import { createWorkspaceHandler } from "./workspace-handlers";

/**
 * Workspace server actions (T-08). Each export is `action(handler)`: the
 * session is resolved before the handler runs (AC-01). Handlers live in
 * `workspace-handlers.ts` (review RV-C-05).
 */

export const createWorkspaceAction = action(createWorkspaceHandler);
