import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionContext } from "@/server/action";
import { getDataContext } from "@/server/data/context";
import { duplicatePage, movePage } from "@/server/data/page-transfer";
import {
  createPage,
  restorePage,
  trashPage,
  updatePage,
  updatePageIcon,
  updatePagePresentation,
} from "@/server/data/pages";

/**
 * Page server-action handlers (T-10, T-11; review RV-C-05 pattern) and the
 * scope expansion of 2026-10-01 (icons, presentation, Duplicate, Move,
 * Trash/Restore — PRD §12).
 *
 * Plain module (NOT "use server"): exposed only through `action(handler)` in
 * `actions.ts`, which resolves the session first. All authorization happens
 * in the data layer (`authorize()`); ids sent by the client are only
 * authorize targets or route-context checks. Paths used for revalidation or
 * redirect come from the server-resolved workspace, never from the input.
 *
 * DP13: there is no hard-delete handler any more; "Move to Trash" is the only
 * way to remove a page, and it is reversible.
 */

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && Object.hasOwn(input, key)
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

/** Sidebar, Home and lists show titles/icons of every page: refresh the whole app tree. */
function revalidateApp() {
  revalidatePath("/", "layout");
}

/** Create a page from a "New page" form (title defaults to "Untitled"), then open it. */
export async function createPageHandler(session: ActionContext, _previous: unknown, formData: FormData): Promise<never> {
  const ctx = await getDataContext(session);
  const rawTitle = formData.get("title");
  const created = await createPage(ctx, {
    workspaceId: formData.get("workspaceId"),
    title: typeof rawTitle === "string" && rawTitle.trim().length > 0 ? rawTitle : "Untitled",
  });
  revalidatePath(`/w/${created.workspaceId}`);
  revalidateApp();
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
  revalidateApp();
  return { title: saved.title, updatedAt: saved.updatedAt.toISOString() };
}

/** Set (`icon`) or reset (`null`) the page icon: `{ pageId, icon }`. */
export async function updatePageIconHandler(session: ActionContext, input: unknown) {
  const ctx = await getDataContext(session);
  const updated = await updatePageIcon(ctx, { pageId: field(input, "pageId"), icon: field(input, "icon") ?? null });
  revalidateApp();
  return { icon: updated.icon };
}

/** Shared presentation: `{ pageId, font?, smallText?, fullWidth? }`. */
export async function updatePagePresentationHandler(session: ActionContext, input: unknown) {
  const ctx = await getDataContext(session);
  const changes: Record<string, unknown> = { pageId: field(input, "pageId") };
  for (const key of ["font", "smallText", "fullWidth"] as const) {
    const value = field(input, key);
    if (value !== undefined) changes[key] = value;
  }
  const updated = await updatePagePresentation(ctx, changes);
  revalidatePath(`/w/${updated.workspaceId}/p/${updated.id}`);
  return { font: updated.font, smallText: updated.smallText, fullWidth: updated.fullWidth };
}

/** Duplicate a page in its workspace: `{ pageId }`. Returns the new page's location. */
export async function duplicatePageHandler(session: ActionContext, input: unknown) {
  const ctx = await getDataContext(session);
  const created = await duplicatePage(ctx, { pageId: field(input, "pageId") });
  revalidateApp();
  return { id: created.id, workspaceId: created.workspaceId };
}

/** Move a page to another workspace: `{ pageId, destinationWorkspaceId }`. */
export async function movePageHandler(session: ActionContext, input: unknown) {
  const ctx = await getDataContext(session);
  const moved = await movePage(ctx, {
    pageId: field(input, "pageId"),
    destinationWorkspaceId: field(input, "destinationWorkspaceId"),
  });
  revalidateApp();
  return moved;
}

/** Move a page to Trash (soft delete): `{ pageId, workspaceId? }`. */
export async function trashPageHandler(session: ActionContext, input: unknown) {
  const ctx = await getDataContext(session);
  const trashed = await trashPage(ctx, { pageId: field(input, "pageId"), workspaceId: field(input, "workspaceId") });
  revalidateApp();
  return { id: trashed.id, workspaceId: trashed.workspaceId };
}

/** Restore a page from Trash: `{ pageId }`. */
export async function restorePageHandler(session: ActionContext, input: unknown) {
  const ctx = await getDataContext(session);
  const restored = await restorePage(ctx, { pageId: field(input, "pageId") });
  revalidateApp();
  return { id: restored.id, workspaceId: restored.workspaceId };
}
