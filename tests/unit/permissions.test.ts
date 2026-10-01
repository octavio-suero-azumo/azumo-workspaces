import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  can,
  canCreateWorkspace,
  isRole,
  MANAGER_ROLE,
  ROLES,
  type Action,
  type Role,
} from "@/server/authz/permissions";

// TC-14 / AC-15 (unit level): every role × action cell of architecture §5
// (without the DP10 rename row, which is not approved).
//
// The expected table is written out literally here, independently of the
// implementation, so a change to the matrix must be made in both places.
const Y = true;
const N = false;
const EXPECTED: Record<Action, Record<Role, boolean>> = {
  "workspace.view": { owner: Y, editor: Y, viewer: Y },
  "page.view": { owner: Y, editor: Y, viewer: Y },
  "page.create": { owner: Y, editor: Y, viewer: N },
  "page.edit": { owner: Y, editor: Y, viewer: N },
  "page.delete": { owner: Y, editor: Y, viewer: N },
  "attachment.add": { owner: Y, editor: Y, viewer: N },
  "attachment.delete": { owner: Y, editor: Y, viewer: N },
  "member.add": { owner: Y, editor: N, viewer: N },
  "member.changeRole": { owner: Y, editor: N, viewer: N },
  "member.remove": { owner: Y, editor: N, viewer: N },
};

const CELLS = ACTIONS.flatMap((action) =>
  ROLES.map((role) => [role, action, EXPECTED[action][role]] as const),
);

describe("permission matrix (TC-14)", () => {
  it("covers exactly the approved roles and actions (PR3; no DP10 rename)", () => {
    expect([...ROLES]).toEqual(["owner", "editor", "viewer"]);
    expect([...ACTIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(ACTIONS).not.toContain("workspace.rename");
    expect(CELLS).toHaveLength(30);
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
