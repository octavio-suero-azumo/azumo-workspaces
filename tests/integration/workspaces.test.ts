import { and, count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authorize } from "@/server/authz/authorize";
import { addMember } from "@/server/data/members";
import { listPages } from "@/server/data/pages";
import { createWorkspace, getWorkspace, listMyWorkspaces } from "@/server/data/workspaces";
import { membership, workspace } from "@/server/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { FIXTURE_PAGE_TITLES, snapshotAppTables } from "../support/fixtures";
import { useFixtureDb } from "../support/fixture-db";

// T-08: workspaces. TC-09 (AC-08), TC-10 (AC-09), TC-11 data level (AC-13),
// TC-12 data level (AC-37).
describe("workspaces (T-08)", () => {
  const t = useFixtureDb();

  describe("AC-08: listMyWorkspaces returns only my workspaces", () => {
    it("alice (W1 Owner, W2 Viewer) sees exactly W1 and W2, never W3", async () => {
      const list = await listMyWorkspaces(t.as("alice"));
      expect(list).toEqual([
        // `icon: null` = default icon (scope expansion E2, 2026-10-01).
        { id: t.fx.workspaces.w1.id, name: t.fx.workspaces.w1.name, icon: null, role: "owner" },
        { id: t.fx.workspaces.w2.id, name: t.fx.workspaces.w2.name, icon: null, role: "viewer" },
      ]);
      expect(list.map((w) => w.id)).not.toContain(t.fx.workspaces.w3.id);
    });

    it.each([
      ["bob", ["w1"]],
      ["carol", ["w1"]],
      ["dave", ["w2"]],
      ["erin", ["w3"]],
      ["outsider", []],
    ] as const)("%s sees %j", async (who, expected) => {
      const list = await listMyWorkspaces(t.as(who));
      expect(list.map((w) => w.id)).toEqual(expected.map((k) => t.fx.workspaces[k].id));
    });
  });

  describe("AC-09: createWorkspace", () => {
    it.each([
      ["1 character", "a", "a"],
      ["100 characters", "n".repeat(100), "n".repeat(100)],
      ["surrounding whitespace is trimmed", "   Team space \t", "Team space"],
      ["100 characters after trimming", `  ${"t".repeat(100)}  `, "t".repeat(100)],
      ["100 non-BMP characters (code points)", "😀".repeat(100), "😀".repeat(100)],
    ])("accepts %s and makes the creator Owner", async (_label, input, stored) => {
      const erin = t.as("erin");
      const created = await createWorkspace(erin, { name: input });
      expect(created).toMatchObject({ name: stored, role: "owner" });

      const [row] = await t.db.select().from(workspace).where(eq(workspace.id, created.id));
      expect(row).toMatchObject({ name: stored, createdBy: t.fx.users.erin.id });
      const members = await t.db.select().from(membership).where(eq(membership.workspaceId, created.id));
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ userId: t.fx.users.erin.id, role: "owner" });

      // The new workspace is listed, and the creator has the management role in practice.
      expect((await listMyWorkspaces(erin)).map((w) => w.id)).toContain(created.id);
      await expect(authorize(erin, { workspaceId: created.id }, "member.add")).resolves.toMatchObject({
        role: "owner",
      });
    });

    it.each([
      ["empty", ""],
      ["whitespace only", "   "],
      ["tabs and newlines only", "\t\n "],
      ["101 characters", "x".repeat(101)],
      ["101 characters after trimming", ` ${"x".repeat(101)} `],
      ["101 non-BMP characters", "😀".repeat(101)],
      ["not a string", 42],
      ["missing", undefined],
    ])("rejects %s with a validation error and creates nothing", async (_label, name) => {
      const before = await snapshotAppTables(t.db);
      await expect(createWorkspace(t.as("erin"), { name })).rejects.toBeInstanceOf(ValidationError);
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });

    it("rejects a non-object input", async () => {
      await expect(createWorkspace(t.as("erin"), null)).rejects.toBeInstanceOf(ValidationError);
    });

    it("P5: any authenticated user can create a workspace, including one with no memberships", async () => {
      const created = await createWorkspace(t.as("outsider"), { name: "Outsider's space" });
      expect((await listMyWorkspaces(t.as("outsider"))).map((w) => w.id)).toEqual([created.id]);
    });

    it("the new workspace is invisible to everyone else", async () => {
      const created = await createWorkspace(t.as("erin"), { name: "Private to erin" });
      await expect(getWorkspace(t.as("alice"), created.id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await listMyWorkspaces(t.as("alice"))).map((w) => w.id)).not.toContain(created.id);
    });

    it("the workspace and its Owner membership are written together", async () => {
      const created = await createWorkspace(t.as("bob"), { name: "Atomic" });
      const [{ n }] = await t.db
        .select({ n: count() })
        .from(membership)
        .where(and(eq(membership.workspaceId, created.id), eq(membership.role, "owner")));
      expect(n).toBe(1);
    });
  });

  describe("getWorkspace", () => {
    it("returns the requester's role in that workspace", async () => {
      await expect(getWorkspace(t.as("alice"), t.fx.workspaces.w1.id)).resolves.toMatchObject({ role: "owner" });
      await expect(getWorkspace(t.as("alice"), t.fx.workspaces.w2.id)).resolves.toMatchObject({ role: "viewer" });
    });
  });

  describe("AC-13 (data level): switching workspace switches the page list", () => {
    it("alice W1 → W2 → W1 sees only the selected workspace's pages", async () => {
      const alice = t.as("alice");
      const titles = async (key: "w1" | "w2") =>
        (await listPages(alice, t.fx.workspaces[key].id)).map((p) => p.title).sort();

      expect(await titles("w1")).toEqual([...FIXTURE_PAGE_TITLES.w1].sort());
      expect(await titles("w2")).toEqual([...FIXTURE_PAGE_TITLES.w2].sort());
      expect(await titles("w1")).toEqual([...FIXTURE_PAGE_TITLES.w1].sort());
    });
  });

  describe("AC-37 (data level): alice is Owner in W1 and Viewer in W2, switching back and forth", () => {
    it("W1 writes succeed, W2 writes are Forbidden with no W2 change, in every round", async () => {
      const alice = t.as("alice");
      const { workspaces, users } = t.fx;
      const w2Memberships = async () =>
        t.db.select().from(membership).where(eq(membership.workspaceId, workspaces.w2.id));
      const w2Before = await w2Memberships();

      // Round 1: W1 (allowed) → W2 (denied)
      await expect(
        addMember(alice, { workspaceId: workspaces.w1.id, email: users.outsider.email, role: "viewer" }),
      ).resolves.toMatchObject({ userId: users.outsider.id });
      await expect(
        addMember(alice, { workspaceId: workspaces.w2.id, email: users.outsider.email, role: "viewer" }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // Round 2: back to W1 (allowed) → W2 again (denied)
      await expect(
        addMember(alice, { workspaceId: workspaces.w1.id, email: users.erin.email, role: "editor" }),
      ).resolves.toMatchObject({ userId: users.erin.id });
      await expect(
        addMember(alice, { workspaceId: workspaces.w2.id, email: users.erin.email, role: "editor" }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(await w2Memberships()).toEqual(w2Before);
      await expect(getWorkspace(alice, workspaces.w1.id)).resolves.toMatchObject({ role: "owner" });
      await expect(getWorkspace(alice, workspaces.w2.id)).resolves.toMatchObject({ role: "viewer" });
    });
  });
});
