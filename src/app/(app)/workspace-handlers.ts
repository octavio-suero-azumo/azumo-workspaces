import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionContext } from "@/server/action";
import { getDataContext } from "@/server/data/context";
import { createWorkspace } from "@/server/data/workspaces";

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
