/**
 * Role → action permission matrix (T-04, architecture §5, PR3).
 *
 * Pure lookup, no I/O: safe to import from server code and from UI code that
 * hides controls (R3.4). Hiding a control is a convenience only; every action
 * is enforced server-side by `authorize()` (R3.2).
 *
 * If the role set (PR3) changes, this file and the `membership.role` CHECK
 * (generated from `ROLES`) are the only places to edit.
 *
 * `workspace.rename` (DP10) is intentionally absent: DP10 is not approved.
 */

export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** The role that manages a workspace (R2.2: the creator gets it). */
export const MANAGER_ROLE: Role = "owner";

export const ACTIONS = [
  "workspace.view",
  "page.view",
  "page.create",
  "page.edit",
  "page.delete",
  "attachment.add",
  "attachment.delete",
  "member.add",
  "member.changeRole",
  "member.remove",
] as const;
export type Action = (typeof ACTIONS)[number];

const MATRIX: Readonly<Record<Action, readonly Role[]>> = Object.freeze({
  "workspace.view": ["owner", "editor", "viewer"],
  "page.view": ["owner", "editor", "viewer"],
  "page.create": ["owner", "editor"],
  "page.edit": ["owner", "editor"],
  // DP5: Editors can delete pages.
  "page.delete": ["owner", "editor"],
  "attachment.add": ["owner", "editor"],
  "attachment.delete": ["owner", "editor"],
  // P6: Owner adds existing users by email.
  "member.add": ["owner"],
  // DP3 (last-Owner guard) is enforced in the data layer, not here.
  "member.changeRole": ["owner"],
  "member.remove": ["owner"],
});

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && Object.hasOwn(MATRIX, value);
}

/**
 * Whether `role` may perform `action`. Fails closed: an unknown role or
 * action (for example a value read from an unexpected DB state) is denied.
 */
export function can(role: unknown, action: unknown): boolean {
  if (!isRole(role) || !isAction(action)) return false;
  return MATRIX[action].includes(role);
}

/**
 * Workspace creation is not workspace-scoped (architecture §5). P5 (approved
 * default): any authenticated user of the allowed domain may create one. The
 * domain is already enforced by the session check, so "authenticated" is the
 * whole rule here.
 */
export function canCreateWorkspace(user: { userId: string } | null | undefined): boolean {
  return typeof user?.userId === "string" && user.userId.length > 0;
}
