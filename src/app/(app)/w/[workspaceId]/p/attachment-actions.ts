"use server";

import { action } from "@/server/action";
import { deleteAttachmentHandler, registerUploadHandler } from "./attachment-handlers";

/**
 * Attachment server actions (T-15, T-16). Every export is `action(handler)`:
 * the session is resolved before the handler runs (AC-01). Handlers live in
 * `attachment-handlers.ts` (review RV-C-05 pattern).
 */

export const registerUploadAction = action(registerUploadHandler);

export const deleteAttachmentAction = action(deleteAttachmentHandler);
