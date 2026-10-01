"use server";

import { action } from "@/server/action";
import { addMemberHandler, changeMemberRoleHandler, removeMemberHandler } from "./handlers";

/**
 * Member management actions (T-09). Every export is `action(handler)`: the
 * session is resolved before the handler runs (AC-01). Handlers live in
 * `handlers.ts` (review RV-C-05).
 */

export const addMemberAction = action(addMemberHandler);

export const changeMemberRoleAction = action(changeMemberRoleHandler);

export const removeMemberAction = action(removeMemberHandler);
