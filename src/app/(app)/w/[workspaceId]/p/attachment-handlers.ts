import { revalidatePath } from "next/cache";
import type { ActionContext } from "@/server/action";
import { deleteAttachment, registerUpload } from "@/server/data/attachments";
import { getDataContext } from "@/server/data/context";

/**
 * Attachment server-action handlers (T-15 registerUpload, T-16 delete).
 *
 * Plain module (NOT "use server"): exposed only through `action(handler)` in
 * `attachment-actions.ts`, which resolves the session first (AC-01). All
 * authorization happens in the data layer (`authorize()`); revalidation paths
 * come from the server-resolved page/workspace, never from client input.
 * Results carry no blob URL or pathname (AC-24).
 */

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && Object.hasOwn(input, key)
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

export interface RegisterUploadResult {
  id: string;
  displayName: string;
}

/**
 * After the browser uploaded to the private Blob store: `{ pageId, pathname,
 * displayName }`. Only these keys are forwarded.
 */
export async function registerUploadHandler(session: ActionContext, input: unknown): Promise<RegisterUploadResult> {
  const ctx = await getDataContext(session);
  const created = await registerUpload(ctx, {
    pageId: field(input, "pageId"),
    pathname: field(input, "pathname"),
    displayName: field(input, "displayName"),
  });
  revalidatePath(`/w/${created.workspaceId}/p/${created.pageId}`);
  return { id: created.id, displayName: created.displayName };
}

/** Delete an attachment after the confirm step (form field `attachmentId`). */
export async function deleteAttachmentHandler(
  session: ActionContext,
  _previous: unknown,
  formData: FormData,
): Promise<{ id: string }> {
  const ctx = await getDataContext(session);
  const deleted = await deleteAttachment(ctx, { attachmentId: formData.get("attachmentId") });
  revalidatePath(`/w/${deleted.workspaceId}/p/${deleted.pageId}`);
  return { id: deleted.id };
}
