import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  can,
  canCreateWorkspace,
  isRole,
  MANAGER_ROLE,
  ROLES,
  TRASH_VISIBLE_ACTIONS,
  type Action,
  type Role,
} from "@/server/authz/permissions";

// TC-14 / AC-15 / AC-41 (unit level): every role × action cell of
// architecture §5 plus the scope expansion of 2026-10-01 (PRD §12.3).
// `workspace.edit` (rename + icon) reverses DP10 by user request; the hard
// `page.delete` was replaced by `page.trash` / `page.restore` (DP13).
//
// The expected table is written out literally here, independently of the
// implementation, so a change to the matrix must be made in both places.
const Y = true;
const N = false;
const EXPECTED: Record<Action, Record<Role, boolean>> = {
  "workspace.view": { owner: Y, editor: Y, viewer: Y },
  "workspace.edit": { owner: Y, editor: N, viewer: N },
  "page.view": { owner: Y, editor: Y, viewer: Y },
  "page.create": { owner: Y, editor: Y, viewer: N },
  "page.edit": { owner: Y, editor: Y, viewer: N },
  "page.duplicate": { owner: Y, editor: Y, viewer: N },
  "page.move": { owner: Y, editor: N, viewer: N },
  "page.trash": { owner: Y, editor: Y, viewer: N },
  "page.restore": { owner: Y, editor: Y, viewer: N },
  "trash.view": { owner: Y, editor: Y, viewer: N },
  "attachment.add": { owner: Y, editor: Y, viewer: N },
  "attachment.delete": { owner: Y, editor: Y, viewer: N },
  "member.add": { owner: Y, editor: N, viewer: N },
  "member.changeRole": { owner: Y, editor: N, viewer: N },
  "member.remove": { owner: Y, editor: N, viewer: N },
  "event.view": { owner: Y, editor: Y, viewer: Y },
  "event.create": { owner: Y, editor: Y, viewer: N },
  "event.edit": { owner: Y, editor: Y, viewer: N },
  "event.delete": { owner: Y, editor: Y, viewer: N },
};

const CELLS = ACTIONS.flatMap((action) =>
  ROLES.map((role) => [role, action, EXPECTED[action][role]] as const),
);

describe("permission matrix (TC-14)", () => {
  it("covers exactly the approved roles and actions (PR3; PRD §12.3; no hard page delete)", () => {
    expect([...ROLES]).toEqual(["owner", "editor", "viewer"]);
    expect([...ACTIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(ACTIONS).not.toContain("workspace.rename");
    // DP13: no action may permanently delete a page.
    expect(ACTIONS as readonly string[]).not.toContain("page.delete");
    expect(CELLS).toHaveLength(57);
  });

  it("only page.restore can reach a trashed page (PRD §12.3 trash rule, fail closed)", () => {
    expect([...TRASH_VISIBLE_ACTIONS]).toEqual(["page.restore"]);
  });

  it.each(CELLS)("can(%s, %s) === %s", (role, action, expected) => {
    expect(can(role, action)).toBe(expected);
  });

  it("the management role is owner", () => {
    expect(MANAGER_ROLE).toBe("owner");
  });
});

describe("can() fails closed on unexpected input", () => {
  it.each([
    ["admin", "workspace.view"],
    ["OWNER", "member.add"],
    ["", "page.view"],
    [undefined, "page.view"],
    [null, "page.view"],
    ["owner", "workspace.rename"],
    ["owner", "workspace.delete"],
    ["owner", "page.delete"],
    ["owner", "toString"],
    ["owner", "__proto__"],
    ["owner", undefined],
  ])("can(%j, %j) === false", (role, action) => {
    expect(can(role, action)).toBe(false);
  });

  it("isRole accepts only the configured roles", () => {
    expect(ROLES.every(isRole)).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isRole(1)).toBe(false);
  });
});

describe("canCreateWorkspace (P5: any authenticated user)", () => {
  it("allows any authenticated user", () => {
    expect(canCreateWorkspace({ userId: "user-1" })).toBe(true);
  });

  it.each([[null], [undefined], [{ userId: "" }]])("denies without an authenticated user: %j", (user) => {
    expect(canCreateWorkspace(user)).toBe(false);
  });
});
