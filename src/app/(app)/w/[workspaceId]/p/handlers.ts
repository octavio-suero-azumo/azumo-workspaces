import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionContext } from "@/server/action";
import { getDataContext } from "@/server/data/context";
import { createPage, deletePage, updatePage } from "@/server/data/pages";

/**
 * Page server-action handlers (T-10, T-11, T-12; review RV-C-05 pattern).
 *
 * Plain module (NOT "use server"): exposed only through `action(handler)` in
 * `actions.ts`, which resolves the session first. All authorization happens
 * in the data layer (`authorize()`); the `workspaceId` sent by the client is
 * only an authorize target (create) or a route-context check (save, delete).
 * Paths used for revalidation/redirect come from the server-resolved
 * workspace, never from the form.
 */

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && Object.hasOwn(input, key)
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

/** Create a page from the "New page" form, then open it. */
export async function createPageHandler(session: ActionContext, _previous: unknown, formData: FormData): Promise<never> {
  const ctx = await getDataContext(session);
  const created = await createPage(ctx, {
    workspaceId: formData.get("workspaceId"),
    title: formData.get("title"),
  });
  revalidatePath(`/w/${created.workspaceId}`);
  redirect(`/w/${created.workspaceId}/p/${created.id}`);
}

export interface SavePageResult {
  title: string;
  updatedAt: string;
}

/**
 * Save the editor: `{ pageId, workspaceId, title, content }` where `content`
 * is the editor's JSON document. Only these keys are forwarded.
 */
export async function savePageHandler(session: ActionContext, input: unknown): Promise<SavePageResult> {
  const ctx = await getDataContext(session);
  const saved = await updatePage(ctx, {
    pageId: field(input, "pageId"),
    workspaceId: field(input, "workspaceId"),
    title: field(input, "title"),
    content: field(input, "content"),
  });
  revalidatePath(`/w/${saved.workspaceId}`);
  revalidatePath(`/w/${saved.workspaceId}/p/${saved.id}`);
  return { title: saved.title, updatedAt: saved.updatedAt.toISOString() };
}

/** Delete a page after the confirm step, then go back to the workspace. */
export async function deletePageHandler(session: ActionContext, _previous: unknown, formData: FormData): Promise<never> {
  const ctx = await getDataContext(session);
  const deleted = await deletePage(ctx, {
    pageId: formData.get("pageId"),
    workspaceId: formData.get("workspaceId"),
  });
  revalidatePath(`/w/${deleted.workspaceId}`);
  redirect(`/w/${deleted.workspaceId}`);
}
