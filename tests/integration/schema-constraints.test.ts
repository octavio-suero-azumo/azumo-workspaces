import { count, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { uploadPathPrefix } from "@/lib/attachment-rules";
import { attachment, membership, page, user, workspace } from "@/server/db/schema";
import { useFixtureDb } from "../support/fixture-db";
import {
  expectPgError,
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from "../support/pg-error";

// TC-13 / AC-14 (R3.1) plus the other T-03b DB constraints. These insert rows
// directly (no app code) to prove the database itself enforces the rules.
describe("DB constraints (T-03b)", () => {
  const t = useFixtureDb();

  describe("AC-14: membership", () => {
    it("a duplicate (user, workspace) membership fails with a unique violation", async () => {
      const { users, workspaces } = t.fx;
      const error = await expectPgError(() =>
        t.db.insert(membership).values({ workspaceId: workspaces.w1.id, userId: users.bob.id, role: "viewer" }),
      );
      expect(error).toEqual({ code: PG_UNIQUE_VIOLATION, constraint: "membership_workspace_user_unique" });
      const [{ n }] = await t.db.select({ n: count() }).from(membership).where(eq(membership.userId, users.bob.id));
      expect(n).toBe(1);
    });

    it.each(["admin", "Owner", "", "member"])("role %j outside the configured set fails the DB check", async (role) => {
      const { users, workspaces } = t.fx;
      const error = await expectPgError(() =>
        t.db.insert(membership).values({ workspaceId: workspaces.w1.id, userId: users.outsider.id, role }),
      );
      expect(error).toEqual({ code: PG_CHECK_VIOLATION, constraint: "membership_role_valid" });
    });

    it("updating an existing role to a value outside the set fails the DB check", async () => {
      const error = await expectPgError(() =>
        t.db.update(membership).set({ role: "admin" }).where(eq(membership.id, t.fx.memberships["bob:w1"])),
      );
      expect(error.code).toBe(PG_CHECK_VIOLATION);
    });

    it.each(["owner", "editor", "viewer"])("role %j is accepted", async (role) => {
      await t.db
        .insert(membership)
        .values({ workspaceId: t.fx.workspaces.w3.id, userId: t.fx.users.outsider.id, role });
    });
  });

  describe("workspace.name length 1–100", () => {
    it.each([
      ["empty", ""],
      ["101 characters", "x".repeat(101)],
    ])("%s is rejected by the DB check", async (_label, name) => {
      const error = await expectPgError(() =>
        t.db.insert(workspace).values({ name, createdBy: t.fx.users.outsider.id }),
      );
      expect(error).toEqual({ code: PG_CHECK_VIOLATION, constraint: "workspace_name_length" });
    });

    it.each([["1 character", "x"], ["100 characters", "x".repeat(100)]])("%s is accepted", async (_label, name) => {
      await t.db.insert(workspace).values({ name, createdBy: t.fx.users.outsider.id });
    });
  });

  describe("page.title length 1–200 and composite unique key", () => {
    it.each([
      ["empty", ""],
      ["201 characters", "x".repeat(201)],
    ])("%s is rejected by the DB check", async (_label, title) => {
      const { users, workspaces } = t.fx;
      const error = await expectPgError(() =>
        t.db
          .insert(page)
          .values({ workspaceId: workspaces.w1.id, title, createdBy: users.alice.id, updatedBy: users.alice.id }),
      );
      expect(error).toEqual({ code: PG_CHECK_VIOLATION, constraint: "page_title_length" });
    });

    it("200 characters is accepted", async () => {
      const { users, workspaces } = t.fx;
      await t.db
        .insert(page)
        .values({ workspaceId: workspaces.w1.id, title: "x".repeat(200), createdBy: users.alice.id, updatedBy: users.alice.id });
    });

    it("UNIQUE(id, workspace_id) exists on page (target for the attachment composite FK)", async () => {
      const result = await t.db.execute(
        sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'page_id_workspace_unique'`,
      );
      const rows = (result as unknown as { rows: Array<{ def: string }> }).rows;
      expect(rows).toEqual([{ def: "UNIQUE (id, workspace_id)" }]);
    });

    it("a page cannot reference a workspace that does not exist", async () => {
      const error = await expectPgError(() =>
        t.db.insert(page).values({
          workspaceId: "00000000-0000-4000-8000-000000000000",
          title: "orphan",
          createdBy: t.fx.users.alice.id,
          updatedBy: t.fx.users.alice.id,
        }),
      );
      expect(error.code).toBe(PG_FOREIGN_KEY_VIOLATION);
    });
  });

  describe("cascades", () => {
    it("deleting a workspace removes its memberships and pages, and nothing else", async () => {
      const { workspaces } = t.fx;
      await t.db.delete(workspace).where(eq(workspace.id, workspaces.w2.id));

      const [{ m }] = await t.db.select({ m: count() }).from(membership).where(eq(membership.workspaceId, workspaces.w2.id));
      const [{ p }] = await t.db.select({ p: count() }).from(page).where(eq(page.workspaceId, workspaces.w2.id));
      expect(m).toBe(0);
      expect(p).toBe(0);
      const [{ all }] = await t.db.select({ all: count() }).from(membership);
      expect(all).toBe(4);
    });

    it("deleting a user removes their memberships", async () => {
      const { users, workspaces } = t.fx;
      await t.db.insert(membership).values({ workspaceId: workspaces.w1.id, userId: users.outsider.id, role: "viewer" });
      await t.db.delete(user).where(eq(user.id, users.outsider.id));
      const [{ n }] = await t.db.select({ n: count() }).from(membership).where(eq(membership.userId, users.outsider.id));
      expect(n).toBe(0);
    });
  });

  // T-13 / TC-23 / AC-25 (R4.3). Direct inserts: the database itself rejects
  // inconsistent attachments, whatever the application code does.
  describe("attachment (T-13)", () => {
    type AttachmentInsert = typeof attachment.$inferInsert;

    /** A valid upload row on W1's first page; override any column. */
    const row = (overrides: Partial<AttachmentInsert> = {}): AttachmentInsert => {
      const { workspaces, pages, users } = t.fx;
      const pageId = overrides.pageId ?? pages.w1[0].id;
      const workspaceId = overrides.workspaceId ?? workspaces.w1.id;
      return {
        pageId,
        workspaceId,
        kind: "upload",
        displayName: "spec.pdf",
        blobPathname: `${uploadPathPrefix(workspaceId, pageId)}spec-${Math.random().toString(36).slice(2, 8)}.pdf`,
        contentType: "application/pdf",
        sizeBytes: 100,
        createdBy: users.alice.id,
        ...overrides,
      };
    };

    it("a valid row is accepted", async () => {
      await t.db.insert(attachment).values(row());
    });

    it("AC-25: a workspace_id different from its page's workspace fails the composite FK", async () => {
      const { workspaces, pages } = t.fx;
      const error = await expectPgError(() =>
        t.db.insert(attachment).values(
          row({
            pageId: pages.w1[0].id,
            workspaceId: workspaces.w2.id,
            // Keep the pathname consistent with the claimed ids so only the FK can fail.
            blobPathname: `${uploadPathPrefix(workspaces.w2.id, pages.w1[0].id)}x.pdf`,
          }),
        ),
      );
      expect(error).toEqual({ code: PG_FOREIGN_KEY_VIOLATION, constraint: "attachment_page_workspace_fk" });
    });

    it("AC-25: moving an existing attachment to another workspace fails the composite FK", async () => {
      const error = await expectPgError(() =>
        t.db
          .update(attachment)
          .set({ workspaceId: t.fx.workspaces.w2.id })
          .where(eq(attachment.id, t.fx.attachments.w1.id)),
      );
      expect(error.code).toBeDefined();
      expect([PG_FOREIGN_KEY_VIOLATION, PG_CHECK_VIOLATION]).toContain(error.code);
      const [unchanged] = await t.db.select().from(attachment).where(eq(attachment.id, t.fx.attachments.w1.id));
      expect(unchanged.workspaceId).toBe(t.fx.workspaces.w1.id);
    });

    it("a page that does not exist fails the FK", async () => {
      const error = await expectPgError(() =>
        t.db.insert(attachment).values(row({ pageId: "00000000-0000-4000-8000-000000000000" })),
      );
      expect(error).toEqual({ code: PG_FOREIGN_KEY_VIOLATION, constraint: "attachment_page_workspace_fk" });
    });

    it.each(["link", "Upload", ""])("kind %j fails the kind CHECK (P2 = uploads only)", async (kind) => {
      const error = await expectPgError(() => t.db.insert(attachment).values(row({ kind })));
      expect(error).toEqual({ code: PG_CHECK_VIOLATION, constraint: "attachment_kind_valid" });
    });

    it("blob_pathname is UNIQUE", async () => {
      const error = await expectPgError(() =>
        t.db.insert(attachment).values(row({ blobPathname: t.fx.attachments.w1.blobPathname })),
      );
      expect(error).toEqual({ code: PG_UNIQUE_VIOLATION, constraint: "attachment_blob_pathname_unique" });
    });

    it.each([
      ["another workspace's prefix", () => `${uploadPathPrefix(t.fx.workspaces.w2.id, t.fx.pages.w2[0].id)}x.pdf`],
      ["another page's prefix", () => `${uploadPathPrefix(t.fx.workspaces.w1.id, t.fx.pages.w1[1].id)}x.pdf`],
      ["no prefix", () => "x.pdf"],
    ])("a blob_pathname with %s fails the prefix CHECK (AC-38 defense in depth)", async (_label, pathname) => {
      const error = await expectPgError(() => t.db.insert(attachment).values(row({ blobPathname: pathname() })));
      expect(error).toEqual({ code: PG_CHECK_VIOLATION, constraint: "attachment_blob_pathname_prefix" });
    });

    it.each([
      ["empty", ""],
      ["256 characters", "n".repeat(256)],
    ])("a display_name that is %s fails the length CHECK", async (_label, displayName) => {
      const error = await expectPgError(() => t.db.insert(attachment).values(row({ displayName })));
      expect(error).toEqual({ code: PG_CHECK_VIOLATION, constraint: "attachment_display_name_length" });
    });

    it("a negative size fails the CHECK", async () => {
      const error = await expectPgError(() => t.db.insert(attachment).values(row({ sizeBytes: -1 })));
      expect(error).toEqual({ code: PG_CHECK_VIOLATION, constraint: "attachment_size_non_negative" });
    });

    it.each(["blobPathname", "contentType", "sizeBytes", "displayName"] as const)("%s is NOT NULL", async (column) => {
      const error = await expectPgError(() =>
        t.db.insert(attachment).values({ ...row(), [column]: null } as unknown as AttachmentInsert),
      );
      expect(error.code).toBe("23502");
    });

    it("DP4: deleting a page cascades to its attachments only", async () => {
      await t.db.delete(page).where(eq(page.id, t.fx.pages.w1[0].id));
      const rows = await t.db.select({ id: attachment.id }).from(attachment);
      expect(rows.map((r) => r.id).sort()).toEqual([t.fx.attachments.w2.id, t.fx.attachments.w3.id].sort());
    });

    it("deleting a workspace cascades (via its pages) to its attachments", async () => {
      await t.db.delete(workspace).where(eq(workspace.id, t.fx.workspaces.w2.id));
      const [{ n }] = await t.db.select({ n: count() }).from(attachment).where(eq(attachment.workspaceId, t.fx.workspaces.w2.id));
      expect(n).toBe(0);
      const [{ all }] = await t.db.select({ all: count() }).from(attachment);
      expect(all).toBe(2);
    });

    it("the composite FK is declared as (page_id, workspace_id) → page(id, workspace_id) ON DELETE CASCADE", async () => {
      const result = await t.db.execute(
        sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'attachment_page_workspace_fk'`,
      );
      const rows = (result as unknown as { rows: Array<{ def: string }> }).rows;
      expect(rows).toEqual([
        { def: "FOREIGN KEY (page_id, workspace_id) REFERENCES page(id, workspace_id) ON DELETE CASCADE" },
      ]);
    });
  });
});
