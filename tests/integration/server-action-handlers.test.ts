import { del } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Review RV-C-05: the REAL server-action handlers (the functions the
// "use server" modules wrap with action()) called directly with forged input,
// the way an attacker can call any server action: forged FormData / ids, from
// a Viewer and from non-members. Expected: Forbidden (403) or NotFound (404),
// no data from the target workspace, and an unchanged DB snapshot.
//
// Two framework seams are replaced, nothing else:
// - `getDataContext` returns the per-test database instead of the app's
//   process-wide one (same `{ db, userId }` shape; `userId` still comes from
//   the ActionContext the action() wrapper would build from the session);
// - `next/cache` `revalidatePath` needs a Next request store, so it is a spy.
// `redirect()` from next/navigation is real: it throws NEXT_REDIRECT.
// The Blob server SDK is mocked (SIMULATED): deleting a page deletes its
// attachments' blobs (DP4). Attachment handlers are covered in uploads.test.ts.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/data/context", () => ({ getDataContext: vi.fn() }));
vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/blob")>();
  return { ...actual, head: vi.fn(), get: vi.fn(), del: vi.fn() };
});

import { revalidatePath } from "next/cache";
import {
  addMemberHandler,
  changeMemberRoleHandler,
  removeMemberHandler,
} from "@/app/(app)/w/[workspaceId]/members/handlers";
import { createPageHandler, restorePageHandler, savePageHandler, trashPageHandler } from "@/app/(app)/w/[workspaceId]/p/handlers";
import { createWorkspaceHandler } from "@/app/(app)/workspace-handlers";
import { createActionWrapper, type ActionContext } from "@/server/action";
import { getDataContext } from "@/server/data/context";
import { membership, page, workspace } from "@/server/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { SIMULATED_BLOB_TOKEN } from "../support/blob-sim";
import { snapshotAppTables, type FixtureUserKey } from "../support/fixtures";
import { useFixtureDb } from "../support/fixture-db";
import { formattedDoc } from "../support/page-docs";

type ErrorClass = typeof ForbiddenError | typeof NotFoundError | typeof ValidationError;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function redirectTarget(error: unknown): string | null {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) return null;
  return digest.split(";")[2] ?? null;
}

describe("server-action handlers with forged input (RV-C-05)", () => {
  const t = useFixtureDb();

  beforeAll(() => {
    vi.stubEnv("ALLOWED_GOOGLE_HD", "allowed.test");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", SIMULATED_BLOB_TOKEN);
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("VERCEL_ENV", "");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.mocked(getDataContext).mockImplementation(async (session: { userId: string }) => ({
      db: t.db,
      userId: session.userId,
    }));
    vi.mocked(revalidatePath).mockClear();
    vi.mocked(del).mockReset().mockResolvedValue(undefined);
  });

  const session = (who: FixtureUserKey): ActionContext => ({ userId: t.fx.users[who].id });
  const ids = () => ({
    w1: t.fx.workspaces.w1.id,
    w2: t.fx.workspaces.w2.id,
    w1Page: t.fx.pages.w1[0].id,
    w2Page: t.fx.pages.w2[0].id,
  });

  /** Denied with the given class, no foreign data in the error, no DB change, no revalidation. */
  async function expectDenied(call: () => Promise<unknown>, errorClass: ErrorClass) {
    const before = await snapshotAppTables(t.db);
    const error = await call().then(
      () => {
        throw new Error("expected the handler to be denied, but it succeeded");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(errorClass);
    const text = JSON.stringify({ message: (error as Error).message, ...(error as object) });
    for (const w of Object.values(t.fx.workspaces)) expect(text).not.toContain(w.name);
    for (const p of [...t.fx.pages.w1, ...t.fx.pages.w2, ...t.fx.pages.w3]) expect(text).not.toContain(p.title);
    expect(await snapshotAppTables(t.db)).toEqual(before);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  }

  describe("createWorkspaceHandler", () => {
    it("P5: any authenticated user creates a workspace; forged author fields are ignored", async () => {
      const error = await createWorkspaceHandler(
        session("outsider"),
        null,
        form({ name: " Forged ", createdBy: t.fx.users.alice.id, id: t.fx.workspaces.w1.id, role: "owner" }),
      ).catch((e: unknown) => e);

      const target = redirectTarget(error);
      expect(target).toMatch(/^\/w\/[0-9a-f-]{36}$/);
      const id = (target as string).split("/")[2];
      expect((await t.db.select().from(workspace).where(eq(workspace.id, id)))[0]).toMatchObject({
        name: "Forged",
        createdBy: t.fx.users.outsider.id,
      });
      expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    });

    it.each([
      ["missing", {}],
      ["whitespace only", { name: "   " }],
      ["101 characters", { name: "x".repeat(101) }],
    ])("a %s name is a validation error and writes nothing", async (_label, fields) => {
      await expectDenied(() => createWorkspaceHandler(session("carol"), null, form(fields)), ValidationError);
    });
  });

  describe("member handlers", () => {
    it("addMember: Viewer → Forbidden; non-member → NotFound; forged foreign workspaceId → NotFound/Forbidden", async () => {
      const { w1, w2 } = ids();
      const add = (who: FixtureUserKey, workspaceId: string) =>
        addMemberHandler(session(who), null, form({ workspaceId, email: t.fx.users.outsider.email, role: "owner" }));

      await expectDenied(() => add("carol", w1), ForbiddenError);
      await expectDenied(() => add("outsider", w1), NotFoundError);
      await expectDenied(() => add("bob", w2), NotFoundError);
      await expectDenied(() => add("alice", w2), ForbiddenError);
    });

    it("changeMemberRole: Viewer → Forbidden; non-member → NotFound; foreign membershipId with W1 context → denied", async () => {
      const change = (who: FixtureUserKey, membershipId: string) =>
        changeMemberRoleHandler(session(who), null, form({ membershipId, role: "owner", workspaceId: ids().w1 }));

      await expectDenied(() => change("carol", t.fx.memberships["carol:w1"]), ForbiddenError);
      await expectDenied(() => change("carol", t.fx.memberships["alice:w1"]), ForbiddenError);
      await expectDenied(() => change("outsider", t.fx.memberships["bob:w1"]), NotFoundError);
      await expectDenied(() => change("bob", t.fx.memberships["dave:w2"]), NotFoundError);
      await expectDenied(() => change("alice", t.fx.memberships["dave:w2"]), ForbiddenError);
      await expectDenied(() => change("alice", t.fx.memberships["alice:w2"]), ForbiddenError);
    });

    it("removeMember: Viewer → Forbidden; non-member → NotFound; foreign membershipId → denied", async () => {
      const remove = (who: FixtureUserKey, membershipId: string) =>
        removeMemberHandler(session(who), null, form({ membershipId, workspaceId: ids().w1 }));

      await expectDenied(() => remove("carol", t.fx.memberships["bob:w1"]), ForbiddenError);
      await expectDenied(() => remove("outsider", t.fx.memberships["bob:w1"]), NotFoundError);
      await expectDenied(() => remove("bob", t.fx.memberships["dave:w2"]), NotFoundError);
      await expectDenied(() => remove("alice", t.fx.memberships["dave:w2"]), ForbiddenError);
    });

    it("control: the Owner's real request succeeds and revalidates the server-resolved workspace", async () => {
      const { w1 } = ids();
      await expect(
        addMemberHandler(session("alice"), null, form({ workspaceId: w1, email: t.fx.users.outsider.email, role: "viewer" })),
      ).resolves.toEqual({ email: t.fx.users.outsider.email, role: "viewer" });
      expect(revalidatePath).toHaveBeenCalledWith(`/w/${w1}/members`);
      const rows = await t.db.select().from(membership).where(eq(membership.userId, t.fx.users.outsider.id));
      expect(rows).toHaveLength(1);
    });
  });

  describe("page handlers", () => {
    it("createPage: Viewer → Forbidden; non-member → NotFound; forged foreign workspaceId → denied", async () => {
      const { w1, w2 } = ids();
      const create = (who: FixtureUserKey, workspaceId: string) =>
        createPageHandler(session(who), null, form({ workspaceId, title: "Forged page" }));

      await expectDenied(() => create("carol", w1), ForbiddenError);
      await expectDenied(() => create("outsider", w1), NotFoundError);
      await expectDenied(() => create("bob", w2), NotFoundError);
      await expectDenied(() => create("alice", w2), ForbiddenError);
      await expectDenied(
        () => createPageHandler(session("carol"), null, form({ workspaceId: "not-a-uuid", title: "x" })),
        NotFoundError,
      );
    });

    it("createPage control: an Editor creates the page, then is redirected to it", async () => {
      const { w1 } = ids();
      const error = await createPageHandler(
        session("bob"),
        null,
        form({ workspaceId: w1, title: "From the form", createdBy: t.fx.users.alice.id }),
      ).catch((e: unknown) => e);

      const target = redirectTarget(error);
      expect(target).toMatch(new RegExp(`^/w/${w1}/p/[0-9a-f-]{36}$`));
      const pageId = (target as string).split("/")[4];
      expect((await t.db.select().from(page).where(eq(page.id, pageId)))[0]).toMatchObject({
        workspaceId: w1,
        title: "From the form",
        createdBy: t.fx.users.bob.id,
      });
      expect(revalidatePath).toHaveBeenCalledWith(`/w/${w1}`);
    });

    it("savePage: Viewer → Forbidden; non-member → NotFound; W2 pageId with W1 context → denied", async () => {
      const { w1, w2, w1Page, w2Page } = ids();
      const save = (who: FixtureUserKey, pageId: string, workspaceId: string) =>
        savePageHandler(session(who), { pageId, workspaceId, title: "Hacked", content: formattedDoc() });

      await expectDenied(() => save("carol", w1Page, w1), ForbiddenError);
      await expectDenied(() => save("outsider", w1Page, w1), NotFoundError);
      await expectDenied(() => save("bob", w2Page, w1), NotFoundError);
      await expectDenied(() => save("alice", w2Page, w1), ForbiddenError);
      await expectDenied(() => save("dave", w2Page, w1), NotFoundError);
      await expectDenied(() => save("dave", w1Page, w2), NotFoundError);
    });

    it.each([
      ["a string", "pageId=x"],
      ["null", null],
      ["an array", [{ pageId: "x" }]],
    ])("savePage with %s as input is a validation error", async (_label, input) => {
      await expectDenied(() => savePageHandler(session("bob"), input), ValidationError);
    });

    it("savePage control: only title/content are written; forged author/workspace keys are ignored", async () => {
      const { w1, w1Page } = ids();
      const content = formattedDoc();
      await expect(
        savePageHandler(session("bob"), {
          pageId: w1Page,
          workspaceId: w1,
          title: "Saved",
          content,
          createdBy: t.fx.users.dave.id,
          workspace_id: ids().w2,
          updatedBy: t.fx.users.dave.id,
        }),
      ).resolves.toMatchObject({ title: "Saved" });

      const [row] = await t.db.select().from(page).where(eq(page.id, w1Page));
      expect(row).toMatchObject({
        title: "Saved",
        content,
        workspaceId: w1,
        createdBy: t.fx.users.alice.id,
        updatedBy: t.fx.users.bob.id,
      });
      expect(revalidatePath).toHaveBeenCalledWith(`/w/${w1}`);
      expect(revalidatePath).toHaveBeenCalledWith(`/w/${w1}/p/${w1Page}`);
    });

    it("trashPage: Viewer → Forbidden; non-member → NotFound; W2 pageId with W1 context → denied", async () => {
      const { w1, w2, w1Page, w2Page } = ids();
      const trash = (who: FixtureUserKey, pageId: string, workspaceId: string) =>
        trashPageHandler(session(who), { pageId, workspaceId });

      await expectDenied(() => trash("carol", w1Page, w1), ForbiddenError);
      await expectDenied(() => trash("outsider", w1Page, w1), NotFoundError);
      await expectDenied(() => trash("bob", w2Page, w1), NotFoundError);
      await expectDenied(() => trash("alice", w2Page, w1), ForbiddenError);
      await expectDenied(() => trash("dave", w2Page, w1), NotFoundError);
      await expectDenied(() => trash("carol", w1Page, w2), ForbiddenError);
    });

    it("trashPage control (DP13): an Editor trashes; the row and its file are KEPT; restore brings it back", async () => {
      const { w1, w1Page } = ids();
      await expect(trashPageHandler(session("bob"), { pageId: w1Page, workspaceId: w1 })).resolves.toEqual({
        id: w1Page,
        workspaceId: w1,
      });
      const [row] = await t.db.select().from(page).where(eq(page.id, w1Page));
      expect(row.deletedAt).toBeInstanceOf(Date);
      expect(row.deletedBy).toBe(t.fx.users.bob.id);
      expect(del).not.toHaveBeenCalled();
      expect(revalidatePath).toHaveBeenCalledWith("/", "layout");

      vi.mocked(revalidatePath).mockClear();
      await expectDenied(() => restorePageHandler(session("carol"), { pageId: w1Page }), ForbiddenError);
      await expect(restorePageHandler(session("alice"), { pageId: w1Page })).resolves.toEqual({ id: w1Page, workspaceId: w1 });
      const [restored] = await t.db.select().from(page).where(eq(page.id, w1Page));
      expect(restored.deletedAt).toBeNull();
    });
  });

  describe("through action(): denials become typed results without data", () => {
    const cases: Array<[string, FixtureUserKey, (s: ActionContext) => Promise<unknown>, "FORBIDDEN" | "NOT_FOUND"]> = [];
    const wrap = (who: FixtureUserKey, run: (s: ActionContext) => Promise<unknown>) =>
      createActionWrapper(async () => ({ userId: t.fx.users[who].id }))(run);

    cases.push(
      ["addMember", "carol", (s) => addMemberHandler(s, null, form({ workspaceId: ids().w1, email: "outsider@allowed.test", role: "owner" })), "FORBIDDEN"],
      ["changeMemberRole", "outsider", (s) => changeMemberRoleHandler(s, null, form({ membershipId: t.fx.memberships["bob:w1"], role: "owner" })), "NOT_FOUND"],
      ["removeMember", "carol", (s) => removeMemberHandler(s, null, form({ membershipId: t.fx.memberships["bob:w1"] })), "FORBIDDEN"],
      ["createPage", "outsider", (s) => createPageHandler(s, null, form({ workspaceId: ids().w1, title: "x" })), "NOT_FOUND"],
      ["savePage", "carol", (s) => savePageHandler(s, { pageId: ids().w1Page, workspaceId: ids().w1, title: "x" }), "FORBIDDEN"],
      ["trashPage", "bob", (s) => trashPageHandler(s, { pageId: ids().w2Page, workspaceId: ids().w1 }), "NOT_FOUND"],
    );

    it.each(cases)("%s as %s → %s", async (_name, who, run, code) => {
      const before = await snapshotAppTables(t.db);
      const result = await wrap(who, run)();
      expect(result).toEqual({ ok: false, error: { code, message: expect.any(String) } });
      const text = JSON.stringify(result);
      for (const w of Object.values(t.fx.workspaces)) expect(text).not.toContain(w.name);
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });
  });
});
