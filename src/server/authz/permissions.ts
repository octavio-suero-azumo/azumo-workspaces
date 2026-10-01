/**
 * Role → action permission matrix (T-04, architecture §5, PR3; scope
 * expansion E1–E10 of 2026-10-01, PRD §12.3).
 *
 * Pure lookup, no I/O: safe to import from server code and from UI code that
 * hides controls (R3.4). Hiding a control is a convenience only; every action
 * is enforced server-side by `authorize()` (R3.2).
 *
 * If the role set (PR3) changes, this file and the `membership.role` CHECK
 * (generated from `ROLES`) are the only places to edit.
 *
 * Expansion notes:
 * - `workspace.edit` (name + icon, Settings) reverses DP10 by user request.
 * - `page.trash` / `page.restore` replace the hard `page.delete` (DP13): there
 *   is no permanent page delete in the app any more.
 * - `page.move` needs Owner in the SOURCE workspace; the destination is
 *   checked separately with `page.create` (conservative initial policy).
 * - `page.edit` also covers the page icon and the shared presentation.
 */

export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** The role that manages a workspace (R2.2: the creator gets it). */
export const MANAGER_ROLE: Role = "owner";

export const ACTIONS = [
  "workspace.view",
  "workspace.edit",
  "page.view",
  "page.create",
  "page.edit",
  "page.duplicate",
  "page.move",
  "page.trash",
  "page.restore",
  "trash.view",
  "attachment.add",
  "attachment.delete",
  "member.add",
  "member.changeRole",
  "member.remove",
  "event.view",
  "event.create",
  "event.edit",
  "event.delete",
] as const;
export type Action = (typeof ACTIONS)[number];

const ALL: readonly Role[] = ["owner", "editor", "viewer"];
const WRITERS: readonly Role[] = ["owner", "editor"];
const OWNER: readonly Role[] = ["owner"];

const MATRIX: Readonly<Record<Action, readonly Role[]>> = Object.freeze({
  "workspace.view": ALL,
  "workspace.edit": OWNER,
  "page.view": ALL,
  "page.create": WRITERS,
  "page.edit": WRITERS,
  "page.duplicate": WRITERS,
  "page.move": OWNER,
  // DP5 roles carried over from the former hard delete.
  "page.trash": WRITERS,
  "page.restore": WRITERS,
  "trash.view": WRITERS,
  "attachment.add": WRITERS,
  "attachment.delete": WRITERS,
  // P6: Owner adds existing users by email (also from the Share dialog).
  "member.add": OWNER,
  // DP3 (last-Owner guard) is enforced in the data layer, not here.
  "member.changeRole": OWNER,
  "member.remove": OWNER,
  "event.view": ALL,
  "event.create": WRITERS,
  "event.edit": WRITERS,
  "event.delete": WRITERS,
});

/**
 * The only actions for which a TRASHED page still resolves (PRD §12.3 trash
 * rule). Every other action on a trashed page — view, edit, files, events,
 * duplicate, move — is NotFound. Pinned by tests/unit/permissions.test.ts.
 */
export const TRASH_VISIBLE_ACTIONS: ReadonlySet<Action> = new Set<Action>(["page.restore"]);

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
