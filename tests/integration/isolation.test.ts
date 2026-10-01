import { del, get, head } from "@vercel/blob";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `@vercel/blob` is mocked only to prove that no denied call reaches the Blob
// store (every denial below happens before any Blob call).
vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/blob")>();
  return { ...actual, head: vi.fn(), get: vi.fn(), del: vi.fn() };
});

import { uploadPathPrefix } from "@/lib/attachment-rules";
import { authorize } from "@/server/authz/authorize";
import {
  authorizeUploadRequest,
  deleteAttachment,
  getAttachmentDownload,
  listAttachments,
  registerUpload,
} from "@/server/data/attachments";
import type { DataContext } from "@/server/data/context";
import { addMember, changeMemberRole, listMembers, removeMember } from "@/server/data/members";
import { createPage, deletePage, getPage, listPages, updatePage } from "@/server/data/pages";
import { getWorkspace, listMyWorkspaces } from "@/server/data/workspaces";
import { DEFAULT_UPLOAD_ALLOWED_TYPES, DEFAULT_UPLOAD_MAX_BYTES } from "@/server/env";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { snapshotAppTables, type Fixtures } from "../support/fixtures";
import { useFixtureDb } from "../support/fixture-db";

// Cross-workspace isolation (R2.3):
// - TC-19 / AC-10: a non-member cannot read W2 (workspace, page list, page, member list, attachment list, attachment).
// - TC-20 / AC-11: a non-member cannot write W2 (pages, attachments, members); W2 rows unchanged.
// - TC-22 (b) / AC-12: every workspace-scoped data function, called as a non-member.
// - TC-21 / AC-38: payload ID substitution by a member; 0 rows affected.
//
// Attachment functions (increment E) are called for real. No denied call may
// reach the (mocked) Blob store.

const LIMITS = { maxBytes: DEFAULT_UPLOAD_MAX_BYTES, allowedTypes: DEFAULT_UPLOAD_ALLOWED_TYPES };

/** Token-route input for a page: a pathname under `prefixOf` and the page id in clientPayload. */
function uploadRequest(pathname: string, pageId: string) {
  return { pathname, clientPayload: JSON.stringify({ pageId, size: 10, contentType: "application/pdf" }) };
}

async function expectDenied(promise: Promise<unknown>, errorClass: typeof NotFoundError | typeof ForbiddenError, fx: Fixtures) {
  const error = await promise.then(
    () => {
      throw new Error("expected the call to be denied, but it succeeded");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(errorClass);
  // "Denied" means no data from the target workspace (PRD §10).
  const text = JSON.stringify({ message: (error as Error).message, ...(error as object) });
  for (const w of [fx.workspaces.w2]) {
    expect(text).not.toContain(w.name);
  }
  for (const p of fx.pages.w2) {
    expect(text).not.toContain(p.title);
  }
  expect(text).not.toContain(fx.attachments.w2.displayName);
  expect(text).not.toContain(fx.attachments.w2.blobPathname);
}

describe("workspace isolation", () => {
  const t = useFixtureDb();

  beforeEach(() => {
    vi.mocked(head).mockReset();
    vi.mocked(get).mockReset();
    vi.mocked(del).mockReset();
  });

  const expectNoBlobCalls = () => {
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  };

  describe.each(["bob", "outsider"] as const)("%s is not a member of W2", (who) => {
    it("AC-10: every read of W2 is NotFound", async () => {
      const ctx = t.as(who);
      const { workspaces, pages, memberships, attachments } = t.fx;
      await expectDenied(getWorkspace(ctx, workspaces.w2.id), NotFoundError, t.fx);
      await expectDenied(listPages(ctx, workspaces.w2.id), NotFoundError, t.fx);
      await expectDenied(listMembers(ctx, workspaces.w2.id), NotFoundError, t.fx);
      await expectDenied(getPage(ctx, { pageId: pages.w2[0].id }), NotFoundError, t.fx);
      await expectDenied(getPage(ctx, { pageId: pages.w2[0].id, workspaceId: workspaces.w2.id }), NotFoundError, t.fx);
      await expectDenied(authorize(ctx, { pageId: pages.w2[0].id }, "page.view"), NotFoundError, t.fx);
      await expectDenied(authorize(ctx, { membershipId: memberships["dave:w2"] }, "workspace.view"), NotFoundError, t.fx);
      // Attachments (real data functions, increment E).
      await expectDenied(listAttachments(ctx, { pageId: pages.w2[0].id }), NotFoundError, t.fx);
      await expectDenied(getAttachmentDownload(ctx, { attachmentId: attachments.w2.id }), NotFoundError, t.fx);
      await expectDenied(authorize(ctx, { attachmentId: attachments.w2.id }, "page.view"), NotFoundError, t.fx);
      expect((await listMyWorkspaces(ctx)).map((w) => w.id)).not.toContain(workspaces.w2.id);
      expectNoBlobCalls();
    });

    it("AC-11: every write to W2 is NotFound and W2's rows are unchanged", async () => {
      const ctx = t.as(who);
      const { workspaces, pages, memberships, users, attachments } = t.fx;
      const before = await snapshotAppTables(t.db);

      // Members (real data functions).
      await expectDenied(
        addMember(ctx, { workspaceId: workspaces.w2.id, email: users[who].email, role: "owner" }),
        NotFoundError,
        t.fx,
      );
      await expectDenied(
        changeMemberRole(ctx, { membershipId: memberships["dave:w2"], role: "viewer" }),
        NotFoundError,
        t.fx,
      );
      await expectDenied(removeMember(ctx, { membershipId: memberships["alice:w2"] }), NotFoundError, t.fx);

      // Pages (real data functions, increment D).
      await expectDenied(createPage(ctx, { workspaceId: workspaces.w2.id, title: "Injected" }), NotFoundError, t.fx);
      await expectDenied(updatePage(ctx, { pageId: pages.w2[0].id, title: "Hijacked" }), NotFoundError, t.fx);
      await expectDenied(deletePage(ctx, { pageId: pages.w2[0].id }), NotFoundError, t.fx);

      // Attachments (real data functions, increment E).
      const w2Prefix = uploadPathPrefix(workspaces.w2.id, pages.w2[0].id);
      await expectDenied(
        authorizeUploadRequest(ctx, uploadRequest(`${w2Prefix}x.pdf`, pages.w2[0].id), LIMITS),
        NotFoundError,
        t.fx,
      );
      await expectDenied(
        registerUpload(ctx, { pageId: pages.w2[0].id, pathname: `${w2Prefix}x.pdf`, displayName: "x.pdf" }),
        NotFoundError,
        t.fx,
      );
      await expectDenied(deleteAttachment(ctx, { attachmentId: attachments.w2.id }), NotFoundError, t.fx);

      expect(await snapshotAppTables(t.db)).toEqual(before);
      expectNoBlobCalls();
    });
  });

  describe("AC-12 / TC-22 (b): every workspace-scoped data function, as a non-member", () => {
    // outsider has no memberships; target W1.
    const calls: Array<[string, (ctx: DataContext, fx: Fixtures) => Promise<unknown>]> = [
      ["getWorkspace", (ctx, fx) => getWorkspace(ctx, fx.workspaces.w1.id)],
      ["listPages", (ctx, fx) => listPages(ctx, fx.workspaces.w1.id)],
      ["getPage", (ctx, fx) => getPage(ctx, { pageId: fx.pages.w1[0].id })],
      ["createPage", (ctx, fx) => createPage(ctx, { workspaceId: fx.workspaces.w1.id, title: "x" })],
      ["updatePage", (ctx, fx) => updatePage(ctx, { pageId: fx.pages.w1[0].id, title: "x" })],
      ["deletePage", (ctx, fx) => deletePage(ctx, { pageId: fx.pages.w1[0].id })],
      ["listMembers", (ctx, fx) => listMembers(ctx, fx.workspaces.w1.id)],
      [
        "addMember",
        (ctx, fx) => addMember(ctx, { workspaceId: fx.workspaces.w1.id, email: fx.users.outsider.email, role: "owner" }),
      ],
      ["changeMemberRole", (ctx, fx) => changeMemberRole(ctx, { membershipId: fx.memberships["bob:w1"], role: "owner" })],
      ["removeMember", (ctx, fx) => removeMember(ctx, { membershipId: fx.memberships["bob:w1"] })],
      ["listAttachments", (ctx, fx) => listAttachments(ctx, { pageId: fx.pages.w1[0].id })],
      ["getAttachmentDownload", (ctx, fx) => getAttachmentDownload(ctx, { attachmentId: fx.attachments.w1.id })],
      [
        "authorizeUploadRequest",
        (ctx, fx) =>
          authorizeUploadRequest(
            ctx,
            uploadRequest(`${uploadPathPrefix(fx.workspaces.w1.id, fx.pages.w1[0].id)}x.pdf`, fx.pages.w1[0].id),
            LIMITS,
          ),
      ],
      [
        "registerUpload",
        (ctx, fx) =>
          registerUpload(ctx, {
            pageId: fx.pages.w1[0].id,
            pathname: `${uploadPathPrefix(fx.workspaces.w1.id, fx.pages.w1[0].id)}x.pdf`,
            displayName: "x.pdf",
          }),
      ],
      ["deleteAttachment", (ctx, fx) => deleteAttachment(ctx, { attachmentId: fx.attachments.w1.id })],
    ];

    it.each(calls)("%s throws NotFound and changes nothing", async (_name, call) => {
      const before = await snapshotAppTables(t.db);
      await expect(call(t.as("outsider"), t.fx)).rejects.toBeInstanceOf(NotFoundError);
      expect(await snapshotAppTables(t.db)).toEqual(before);
      expectNoBlobCalls();
    });

    it("listMyWorkspaces returns an empty result", async () => {
      expect(await listMyWorkspaces(t.as("outsider"))).toEqual([]);
    });
  });

  describe("AC-38 / TC-21: payload ID substitution is authorized against the resource's real workspace", () => {
    it("(c) alice changes a W2 membership's role from a W1 context → Forbidden, 0 rows changed", async () => {
      const { workspaces, memberships } = t.fx;
      const before = await snapshotAppTables(t.db);
      await expectDenied(
        changeMemberRole(t.as("alice"), {
          workspaceId: workspaces.w1.id, // substituted, must be ignored
          membershipId: memberships["dave:w2"],
          role: "viewer",
        }),
        ForbiddenError,
        t.fx,
      );
      await expectDenied(
        removeMember(t.as("alice"), { workspaceId: workspaces.w1.id, membershipId: memberships["dave:w2"] }),
        ForbiddenError,
        t.fx,
      );
      // Her own W2 membership is still governed by her W2 role (Viewer).
      await expectDenied(
        changeMemberRole(t.as("alice"), {
          workspaceId: workspaces.w1.id,
          membershipId: memberships["alice:w2"],
          role: "owner",
        }),
        ForbiddenError,
        t.fx,
      );
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });

    it("bob (W1 Editor, not in W2) targets a W2 membership with workspaceId=W1 → NotFound, 0 rows changed", async () => {
      const { workspaces, memberships } = t.fx;
      const before = await snapshotAppTables(t.db);
      await expectDenied(
        changeMemberRole(t.as("bob"), {
          workspaceId: workspaces.w1.id,
          membershipId: memberships["dave:w2"],
          role: "viewer",
        }),
        NotFoundError,
        t.fx,
      );
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });

    it("(a) a W2 pageId with workspaceId=W1 is checked against W2 (alice: Viewer → Forbidden)", async () => {
      const { workspaces, pages } = t.fx;
      const substituted = { pageId: pages.w2[0].id, workspaceId: workspaces.w1.id };
      for (const action of ["page.edit", "page.delete", "attachment.add"] as const) {
        await expectDenied(authorize(t.as("alice"), substituted, action), ForbiddenError, t.fx);
      }
    });

    it("(a, real page writes) a W2 pageId with workspaceId=W1 → denied, 0 rows changed", async () => {
      const { workspaces, pages } = t.fx;
      const substituted = { pageId: pages.w2[0].id, workspaceId: workspaces.w1.id };
      const before = await snapshotAppTables(t.db);
      await expectDenied(updatePage(t.as("alice"), { ...substituted, title: "x" }), ForbiddenError, t.fx);
      await expectDenied(deletePage(t.as("alice"), substituted), ForbiddenError, t.fx);
      // dave is Owner of W2 but the request claims W1's route: NotFound.
      await expectDenied(updatePage(t.as("dave"), { ...substituted, title: "x" }), NotFoundError, t.fx);
      await expectDenied(deletePage(t.as("dave"), substituted), NotFoundError, t.fx);
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });

    it("(b) a W1 pageId with workspaceId=W2 is checked against W1 (dave: non-member → NotFound)", async () => {
      const { workspaces, pages } = t.fx;
      const substituted = { pageId: pages.w1[0].id, workspaceId: workspaces.w2.id };
      await expect(authorize(t.as("dave"), substituted, "attachment.add")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("(d) registerUpload / upload token with a ws/{W2}/… pathname from W1 → Forbidden, 0 rows, no Blob call", async () => {
      const { workspaces, pages } = t.fx;
      const w2Path = `${uploadPathPrefix(workspaces.w2.id, pages.w2[0].id)}x.pdf`;
      const before = await snapshotAppTables(t.db);
      for (const who of ["alice", "bob"] as const) {
        await expectDenied(
          registerUpload(t.as(who), { pageId: pages.w1[0].id, workspaceId: workspaces.w2.id, pathname: w2Path, displayName: "x.pdf" }),
          ForbiddenError,
          t.fx,
        );
        await expectDenied(authorizeUploadRequest(t.as(who), uploadRequest(w2Path, pages.w1[0].id), LIMITS), ForbiddenError, t.fx);
      }
      expect(await snapshotAppTables(t.db)).toEqual(before);
      expectNoBlobCalls();
    });

    it("(e) W2's attachmentId used from W1: bob NotFound (read and delete); alice Forbidden to delete (Viewer in W2)", async () => {
      const { attachments, workspaces } = t.fx;
      const before = await snapshotAppTables(t.db);
      await expectDenied(getAttachmentDownload(t.as("bob"), { attachmentId: attachments.w2.id }), NotFoundError, t.fx);
      await expectDenied(
        deleteAttachment(t.as("bob"), { attachmentId: attachments.w2.id, workspaceId: workspaces.w1.id }),
        NotFoundError,
        t.fx,
      );
      await expectDenied(
        deleteAttachment(t.as("alice"), { attachmentId: attachments.w2.id, workspaceId: workspaces.w1.id }),
        ForbiddenError,
        t.fx,
      );
      const substituted = { attachmentId: attachments.w2.id, workspaceId: workspaces.w1.id };
      await expectDenied(authorize(t.as("alice"), substituted, "attachment.delete"), ForbiddenError, t.fx);
      expect(await snapshotAppTables(t.db)).toEqual(before);
      expectNoBlobCalls();
    });

    it("alice cannot add members to W2 while being Owner of W1 → Forbidden, 0 rows changed", async () => {
      const { workspaces, users } = t.fx;
      const before = await snapshotAppTables(t.db);
      await expectDenied(
        addMember(t.as("alice"), { workspaceId: workspaces.w2.id, email: users.bob.email, role: "owner" }),
        ForbiddenError,
        t.fx,
      );
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });
  });
});
