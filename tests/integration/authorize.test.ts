import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authorize } from "@/server/authz/authorize";
import { ACTIONS, type Action } from "@/server/authz/permissions";
import { membership } from "@/server/db/schema";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import type { FixtureUserKey } from "../support/fixtures";
import { useFixtureDb } from "../support/fixture-db";

// T-05 / TC-15 / AC-15 (authorize level), AC-10/AC-11 (non-member → 404),
// AC-37 (role per workspace) and AC-38 (workspace resolved from the resource).
//
// Expected results are written out literally (independent of permissions.ts).
const ALLOWED: Record<"alice" | "bob" | "carol", readonly Action[]> = {
  // alice = Owner of W1
  alice: [...ACTIONS],
  // bob = Editor of W1
  bob: [
    "workspace.view",
    "page.view",
    "page.create",
    "page.edit",
    "page.delete",
    "attachment.add",
    "attachment.delete",
  ],
  // carol = Viewer of W1
  carol: ["workspace.view", "page.view"],
};

const PAGE_LEVEL = new Set<Action>(["page.view", "page.edit", "page.delete", "attachment.add", "attachment.delete"]);

describe("authorize() (T-05)", () => {
  // Read-only suite except where noted; reset each test anyway (cheap).
  const t = useFixtureDb();

  /** The natural target for an action on W1 (page-level actions target a W1 page). */
  const w1Target = (action: Action) =>
    PAGE_LEVEL.has(action) ? { pageId: t.fx.pages.w1[0].id } : { workspaceId: t.fx.workspaces.w1.id };

  describe("AC-15: every member role × action in W1", () => {
    const cells = (["alice", "bob", "carol"] as const).flatMap((who) =>
      ACTIONS.map((action) => [who, action, ALLOWED[who].includes(action)] as const),
    );

    it.each(cells)("%s → %s allowed=%s", async (who, action, allowed) => {
      const ctx = t.as(who);
      const target = w1Target(action);
      const call = PAGE_LEVEL.has(action)
        ? authorize(ctx, target as { pageId: string }, action)
        : authorize(ctx, target as { workspaceId: string }, action);
      if (allowed) {
        const result = await call;
        expect(result.workspaceId).toBe(t.fx.workspaces.w1.id);
        expect(result.role).toBe({ alice: "owner", bob: "editor", carol: "viewer" }[who]);
      } else {
        await expect(call).rejects.toBeInstanceOf(ForbiddenError);
      }
    });

    it("attachment targets (T-13) follow the same matrix, against the attachment's own workspace", async () => {
      const target = { attachmentId: t.fx.attachments.w1.id };
      for (const who of ["alice", "bob", "carol"] as const) {
        for (const action of ["page.view", "attachment.add", "attachment.delete"] as const) {
          const call = authorize(t.as(who), target, action);
          if (ALLOWED[who].includes(action)) {
            await expect(call).resolves.toMatchObject({
              workspaceId: t.fx.workspaces.w1.id,
              resource: {
                id: t.fx.attachments.w1.id,
                pageId: t.fx.pages.w1[0].id,
                workspaceId: t.fx.workspaces.w1.id,
                displayName: t.fx.attachments.w1.displayName,
              },
            });
          } else {
            await expect(call).rejects.toBeInstanceOf(ForbiddenError);
          }
        }
      }
    });

    it("member-management actions on a membership target follow the same matrix", async () => {
      const target = { membershipId: t.fx.memberships["bob:w1"] };
      await expect(authorize(t.as("alice"), target, "member.changeRole")).resolves.toMatchObject({
        workspaceId: t.fx.workspaces.w1.id,
        role: "owner",
        resource: { id: t.fx.memberships["bob:w1"], userId: t.fx.users.bob.id, role: "editor" },
      });
      await expect(authorize(t.as("bob"), target, "member.remove")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(authorize(t.as("carol"), target, "member.changeRole")).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("AC-10 / AC-11: non-members get NotFound for every action and target kind", () => {
    const nonMembers: FixtureUserKey[] = ["outsider", "dave", "erin"];
    const cells = nonMembers.flatMap((who) => ACTIONS.map((action) => [who, action] as const));

    it.each(cells)("%s → %s on W1 → NotFound", async (who, action) => {
      const ctx = t.as(who);
      await expect(authorize(ctx, { workspaceId: t.fx.workspaces.w1.id }, action)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(authorize(ctx, { pageId: t.fx.pages.w1[0].id }, action)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        authorize(ctx, { membershipId: t.fx.memberships["carol:w1"] }, action),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(authorize(ctx, { attachmentId: t.fx.attachments.w1.id }, action)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("the NotFound error carries no data from the target workspace", async () => {
      const error = await authorize(t.as("outsider"), { workspaceId: t.fx.workspaces.w1.id }, "workspace.view").catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(NotFoundError);
      const text = JSON.stringify({ message: (error as Error).message, ...(error as object) });
      expect(text).not.toContain(t.fx.workspaces.w1.name);
      expect(text).not.toContain(t.fx.workspaces.w1.id);
    });
  });

  describe("unknown or malformed ids resolve to NotFound (no DB error)", () => {
    it.each([
      ["random uuid", "3f2b7c1e-9a4d-4e2f-8b6a-1c2d3e4f5a6b"],
      ["not a uuid", "not-a-uuid"],
      ["sql-ish", "' or 1=1 --"],
      ["empty", ""],
    ])("%s", async (_label, id) => {
      const ctx = t.as("alice");
      await expect(authorize(ctx, { workspaceId: id }, "workspace.view")).rejects.toBeInstanceOf(NotFoundError);
      await expect(authorize(ctx, { pageId: id }, "page.view")).rejects.toBeInstanceOf(NotFoundError);
      await expect(authorize(ctx, { membershipId: id }, "member.remove")).rejects.toBeInstanceOf(NotFoundError);
      await expect(authorize(ctx, { attachmentId: id }, "page.view")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("an id of another kind (a page id used as an attachment id) is NotFound", async () => {
      await expect(
        authorize(t.as("alice"), { attachmentId: t.fx.pages.w1[0].id }, "page.view"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("AC-38: the workspace comes from the resource, never from the payload", () => {
    it("a W2 pageId with workspaceId=W1 is authorized against W2 (alice is Viewer there → Forbidden)", async () => {
      const target = { pageId: t.fx.pages.w2[0].id, workspaceId: t.fx.workspaces.w1.id };
      await expect(authorize(t.as("alice"), target, "page.edit")).rejects.toBeInstanceOf(ForbiddenError);
      // …and view is allowed, but reports the REAL workspace.
      await expect(authorize(t.as("alice"), target, "page.view")).resolves.toMatchObject({
        workspaceId: t.fx.workspaces.w2.id,
        role: "viewer",
      });
    });

    it("a W2 pageId with workspaceId=W1 from bob (member of W1 only) → NotFound", async () => {
      const target = { pageId: t.fx.pages.w2[0].id, workspaceId: t.fx.workspaces.w1.id };
      await expect(authorize(t.as("bob"), target, "page.view")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("a W2 membershipId from a W1 Owner context → Forbidden (alice is Viewer in W2)", async () => {
      const target = { membershipId: t.fx.memberships["dave:w2"], workspaceId: t.fx.workspaces.w1.id };
      await expect(authorize(t.as("alice"), target, "member.changeRole")).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("a W1 pageId with workspaceId=W2 (dave, Owner of W2) → NotFound", async () => {
      const target = { pageId: t.fx.pages.w1[0].id, workspaceId: t.fx.workspaces.w2.id };
      await expect(authorize(t.as("dave"), target, "page.edit")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("a W2 attachmentId with workspaceId=W1: alice (Viewer in W2) may view but not delete; bob → NotFound", async () => {
      const target = { attachmentId: t.fx.attachments.w2.id, workspaceId: t.fx.workspaces.w1.id };
      await expect(authorize(t.as("alice"), target, "attachment.delete")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(authorize(t.as("alice"), target, "page.view")).resolves.toMatchObject({
        workspaceId: t.fx.workspaces.w2.id,
        role: "viewer",
      });
      await expect(authorize(t.as("bob"), target, "page.view")).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("AC-37: the role never carries over between workspaces", () => {
    it("alice: W1 → W2 → W1 → W2 gets Owner / Viewer permissions every time", async () => {
      const alice = t.as("alice");
      const w1 = { workspaceId: t.fx.workspaces.w1.id };
      const w2 = { workspaceId: t.fx.workspaces.w2.id };
      for (let round = 0; round < 2; round += 1) {
        await expect(authorize(alice, w1, "page.create")).resolves.toMatchObject({ role: "owner" });
        await expect(authorize(alice, w1, "member.add")).resolves.toMatchObject({ role: "owner" });
        await expect(authorize(alice, w2, "page.create")).rejects.toBeInstanceOf(ForbiddenError);
        await expect(authorize(alice, w2, "member.add")).rejects.toBeInstanceOf(ForbiddenError);
        await expect(authorize(alice, w2, "workspace.view")).resolves.toMatchObject({ role: "viewer" });
      }
    });
  });

  describe("the role is read from the DB on every call (no caching)", () => {
    it("a role change takes effect on the next authorize() call", async () => {
      const bob = t.as("bob");
      const w1 = { workspaceId: t.fx.workspaces.w1.id };
      await expect(authorize(bob, w1, "page.create")).resolves.toMatchObject({ role: "editor" });

      await t.db.update(membership).set({ role: "viewer" }).where(eq(membership.id, t.fx.memberships["bob:w1"]));
      await expect(authorize(bob, w1, "page.create")).rejects.toBeInstanceOf(ForbiddenError);

      await t.db.delete(membership).where(eq(membership.id, t.fx.memberships["bob:w1"]));
      await expect(authorize(bob, w1, "workspace.view")).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
