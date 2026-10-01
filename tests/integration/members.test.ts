import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { authorize } from "@/server/authz/authorize";
import {
  addMember,
  ALREADY_MEMBER_MESSAGE,
  changeMemberRole,
  LAST_OWNER_MESSAGE,
  listMembers,
  otherOwnersRemain,
  removeMember,
  UNKNOWN_USER_MESSAGE,
} from "@/server/data/members";
import { listPages } from "@/server/data/pages";
import { getWorkspace, listMyWorkspaces } from "@/server/data/workspaces";
import { membership } from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { snapshotAppTables } from "../support/fixtures";
import { useFixtureDb } from "../support/fixture-db";

// T-09: members. TC-16 (AC-16), TC-17 (AC-17), P6, and the member-management
// cells of AC-15 through the data functions (not only authorize()).
describe("members (T-09)", () => {
  const t = useFixtureDb();

  const roleOf = async (membershipId: string) =>
    (await t.db.select({ role: membership.role }).from(membership).where(eq(membership.id, membershipId)))[0]?.role;

  describe("listMembers: every member can view the member list", () => {
    it.each(["alice", "bob", "carol"] as const)("%s lists W1's members", async (who) => {
      const members = await listMembers(t.as(who), t.fx.workspaces.w1.id);
      expect(members.map((m) => [m.email, m.role])).toEqual([
        [t.fx.users.alice.email, "owner"],
        [t.fx.users.bob.email, "editor"],
        [t.fx.users.carol.email, "viewer"],
      ]);
      expect(members.map((m) => m.membershipId).sort()).toEqual(
        [t.fx.memberships["alice:w1"], t.fx.memberships["bob:w1"], t.fx.memberships["carol:w1"]].sort(),
      );
    });

    it("lists only the requested workspace's members", async () => {
      const members = await listMembers(t.as("alice"), t.fx.workspaces.w2.id);
      expect(members.map((m) => m.email).sort()).toEqual([t.fx.users.alice.email, t.fx.users.dave.email].sort());
    });
  });

  describe("AC-16 / TC-16: an Owner manages members; the change applies on the next request", () => {
    it("alice adds outsider, demotes bob to Viewer, then removes bob", async () => {
      const alice = t.as("alice");
      const bob = t.as("bob");
      const outsider = t.as("outsider");
      const w1 = t.fx.workspaces.w1.id;

      // Add (P6: existing user, by email).
      const added = await addMember(alice, { workspaceId: w1, email: t.fx.users.outsider.email, role: "editor" });
      expect(added).toMatchObject({ userId: t.fx.users.outsider.id, role: "editor" });
      await expect(getWorkspace(outsider, w1)).resolves.toMatchObject({ role: "editor" });
      await expect(authorize(outsider, { workspaceId: w1 }, "page.create")).resolves.toBeDefined();

      // Change role: bob Editor → Viewer. His very next request is a Viewer's.
      await expect(authorize(bob, { workspaceId: w1 }, "page.create")).resolves.toBeDefined();
      await changeMemberRole(alice, { membershipId: t.fx.memberships["bob:w1"], role: "viewer" });
      expect(await roleOf(t.fx.memberships["bob:w1"])).toBe("viewer");
      await expect(authorize(bob, { workspaceId: w1 }, "page.create")).rejects.toBeInstanceOf(ForbiddenError);

      // Remove bob: his next request is NotFound (DP2), and W1 leaves his list.
      await removeMember(alice, { membershipId: t.fx.memberships["bob:w1"] });
      await expect(getWorkspace(bob, w1)).rejects.toBeInstanceOf(NotFoundError);
      await expect(listPages(bob, w1)).rejects.toBeInstanceOf(NotFoundError);
      await expect(listMembers(bob, w1)).rejects.toBeInstanceOf(NotFoundError);
      expect(await listMyWorkspaces(bob)).toEqual([]);
    });

    it.each(["carol", "bob"] as const)("%s (not an Owner) is Forbidden for add, change role and remove; nothing changes", async (who) => {
      const ctx = t.as(who);
      const w1 = t.fx.workspaces.w1.id;
      const before = await snapshotAppTables(t.db);

      await expect(
        addMember(ctx, { workspaceId: w1, email: t.fx.users.outsider.email, role: "viewer" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        changeMemberRole(ctx, { membershipId: t.fx.memberships["alice:w1"], role: "viewer" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        changeMemberRole(ctx, { membershipId: t.fx.memberships[`${who}:w1`], role: "owner" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(removeMember(ctx, { membershipId: t.fx.memberships["alice:w1"] })).rejects.toBeInstanceOf(
        ForbiddenError,
      );

      expect(await snapshotAppTables(t.db)).toEqual(before);
    });
  });

  describe("P6: add by email, existing users only", () => {
    it("an unknown email is a clear validation error and creates nothing", async () => {
      const before = await snapshotAppTables(t.db);
      const error = await addMember(t.as("alice"), {
        workspaceId: t.fx.workspaces.w1.id,
        email: "nobody@allowed.test",
        role: "viewer",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toBe(UNKNOWN_USER_MESSAGE);
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });

    it("email matching is case-insensitive and ignores surrounding whitespace", async () => {
      const added = await addMember(t.as("alice"), {
        workspaceId: t.fx.workspaces.w1.id,
        email: "  OUTSIDER@Allowed.Test ",
        role: "viewer",
      });
      expect(added.userId).toBe(t.fx.users.outsider.id);
    });

    it("adding an existing member is a 409 conflict and changes nothing", async () => {
      const before = await snapshotAppTables(t.db);
      const error = await addMember(t.as("alice"), {
        workspaceId: t.fx.workspaces.w1.id,
        email: t.fx.users.bob.email,
        role: "owner",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as Error).message).toBe(ALREADY_MEMBER_MESSAGE);
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });

    it.each([
      ["invalid email", { email: "not-an-email", role: "viewer" }],
      ["missing email", { role: "viewer" }],
      ["invalid role", { email: "outsider@allowed.test", role: "admin" }],
      ["missing role", { email: "outsider@allowed.test" }],
    ])("%s is a validation error and creates nothing", async (_label, fields) => {
      const before = await snapshotAppTables(t.db);
      await expect(
        addMember(t.as("alice"), { workspaceId: t.fx.workspaces.w1.id, ...fields }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });

    it("an invalid role on changeMemberRole is a validation error and changes nothing", async () => {
      const before = await snapshotAppTables(t.db);
      await expect(
        changeMemberRole(t.as("alice"), { membershipId: t.fx.memberships["bob:w1"], role: "admin" }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });
  });

  describe("AC-17 / TC-17 (DP3): the last Owner can be neither demoted nor removed", () => {
    it.each(["editor", "viewer"] as const)("alice (only Owner of W1) demoting herself to %s → 409, unchanged", async (role) => {
      const before = await snapshotAppTables(t.db);
      const error = await changeMemberRole(t.as("alice"), {
        membershipId: t.fx.memberships["alice:w1"],
        role,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as Error).message).toBe(LAST_OWNER_MESSAGE);
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });

    it("alice (only Owner of W1) removing herself → 409, unchanged", async () => {
      const before = await snapshotAppTables(t.db);
      await expect(removeMember(t.as("alice"), { membershipId: t.fx.memberships["alice:w1"] })).rejects.toBeInstanceOf(
        ConflictError,
      );
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });

    it("dave (only Owner of W2) removing himself → 409", async () => {
      await expect(removeMember(t.as("dave"), { membershipId: t.fx.memberships["dave:w2"] })).rejects.toBeInstanceOf(
        ConflictError,
      );
      expect(await roleOf(t.fx.memberships["dave:w2"])).toBe("owner");
    });

    it("re-confirming the last Owner as owner is a no-op success", async () => {
      await expect(
        changeMemberRole(t.as("alice"), { membershipId: t.fx.memberships["alice:w1"], role: "owner" }),
      ).resolves.toMatchObject({ role: "owner" });
    });

    it("with a second Owner the first can step down; then the new sole Owner is guarded", async () => {
      const alice = t.as("alice");
      const bob = t.as("bob");
      await changeMemberRole(alice, { membershipId: t.fx.memberships["bob:w1"], role: "owner" });
      await changeMemberRole(alice, { membershipId: t.fx.memberships["alice:w1"], role: "editor" });
      expect(await roleOf(t.fx.memberships["alice:w1"])).toBe("editor");

      await expect(
        changeMemberRole(bob, { membershipId: t.fx.memberships["bob:w1"], role: "viewer" }),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(removeMember(bob, { membershipId: t.fx.memberships["bob:w1"] })).rejects.toBeInstanceOf(
        ConflictError,
      );
      // Removing a non-Owner is not affected by the guard.
      await expect(removeMember(bob, { membershipId: t.fx.memberships["carol:w1"] })).resolves.toMatchObject({
        workspaceId: t.fx.workspaces.w1.id,
      });
    });

    it("RV-C-04: the owner-row lock is taken in a fixed order (ORDER BY id … FOR UPDATE)", () => {
      // Static check of the generated SQL only; PGlite cannot exercise two
      // concurrent transactions, so the deadlock-avoidance claim stays unverified.
      const { sql: text } = new PgDialect().sqlToQuery(otherOwnersRemain("00000000-0000-4000-8000-000000000000"));
      expect(text.replace(/\s+/g, " ")).toMatch(/order by "owner_row"\."id" for update/i);
    });

    it("an Owner can remove another Owner while one remains", async () => {
      const alice = t.as("alice");
      await changeMemberRole(alice, { membershipId: t.fx.memberships["bob:w1"], role: "owner" });
      await removeMember(alice, { membershipId: t.fx.memberships["bob:w1"] });
      expect(await roleOf(t.fx.memberships["bob:w1"])).toBeUndefined();
      expect(await roleOf(t.fx.memberships["alice:w1"])).toBe("owner");
    });
  });

  describe("unknown membership ids", () => {
    it("change role / remove on a missing membership → NotFound", async () => {
      const id = "8a1c1f0e-5b1d-4c4e-9f0a-1b2c3d4e5f60";
      await expect(changeMemberRole(t.as("alice"), { membershipId: id, role: "viewer" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(removeMember(t.as("alice"), { membershipId: id })).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
