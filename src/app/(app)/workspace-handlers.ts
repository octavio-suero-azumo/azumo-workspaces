import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionContext } from "@/server/action";
import { getDataContext } from "@/server/data/context";
import { createWorkspace, updateWorkspace } from "@/server/data/workspaces";

/**
 * Server-action handlers for workspaces (review RV-C-05).
 *
 * Plain module (NOT "use server"): these functions are not endpoints by
 * themselves. They are exposed only through `action(handler)` in
 * `workspace-actions.ts`, which resolves the session first. Keeping them here
 * lets integration tests call the real handler with forged input.
 */

/** Create a workspace (T-08, R2.2, P5). The creator becomes Owner; then go to it. */
export async function createWorkspaceHandler(
  session: ActionContext,
  _previous: unknown,
  formData: FormData,
): Promise<never> {
  const ctx = await getDataContext(session);
  const created = await createWorkspace(ctx, { name: formData.get("name") });
  revalidatePath("/", "layout");
  redirect(`/w/${created.id}`);
}

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && Object.hasOwn(input, key)
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Rename a workspace and/or change its icon (Owner only, E2/E6):
 * `{ workspaceId, name?, icon? }` (`icon: null` resets to the default).
 */
export async function updateWorkspaceHandler(session: ActionContext, input: unknown) {
  const ctx = await getDataContext(session);
  const changes: Record<string, unknown> = { workspaceId: field(input, "workspaceId") };
  if (field(input, "name") !== undefined) changes.name = field(input, "name");
  if (field(input, "icon") !== undefined) changes.icon = field(input, "icon");
  const updated = await updateWorkspace(ctx, changes);
  revalidatePath("/", "layout");
  return { id: updated.id, name: updated.name, icon: updated.icon };
}
