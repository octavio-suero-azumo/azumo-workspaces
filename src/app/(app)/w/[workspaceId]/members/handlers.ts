import { revalidatePath } from "next/cache";
import type { ActionContext } from "@/server/action";
import { getDataContext } from "@/server/data/context";
import { addMember, changeMemberRole, removeMember } from "@/server/data/members";

/**
 * Member-management server-action handlers (T-09, review RV-C-05).
 *
 * Plain module (NOT "use server"): exposed only through `action(handler)` in
 * `actions.ts`. Every handler goes through the data layer, which calls
 * `authorize()`. The workspace used for revalidation is the one resolved
 * server-side, never the form value.
 */

export async function addMemberHandler(session: ActionContext, _previous: unknown, formData: FormData) {
  const ctx = await getDataContext(session);
  const added = await addMember(ctx, {
    workspaceId: formData.get("workspaceId"),
    email: formData.get("email"),
    role: formData.get("role"),
  });
  revalidatePath(`/w/${added.workspaceId}/members`);
  return { email: added.email, role: added.role };
}

export async function changeMemberRoleHandler(session: ActionContext, _previous: unknown, formData: FormData) {
  const ctx = await getDataContext(session);
  const changed = await changeMemberRole(ctx, {
    membershipId: formData.get("membershipId"),
    role: formData.get("role"),
  });
  // The requester may have changed their own role (sidebar label, controls).
  revalidatePath("/", "layout");
  return { role: changed.role };
}

export async function removeMemberHandler(session: ActionContext, _previous: unknown, formData: FormData) {
  const ctx = await getDataContext(session);
  const removed = await removeMember(ctx, { membershipId: formData.get("membershipId") });
  revalidatePath("/", "layout");
  return { membershipId: removed.membershipId };
}
