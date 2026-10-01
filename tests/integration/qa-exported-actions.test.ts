import { del, get, head } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// QA independent verification (T-17a / T-17b).
//
// Gap closed: every other test calls the server-action HANDLERS through a
// synthetic `createActionWrapper(fakeResolver)`. None of them calls the REAL
// exported server actions (the `"use server"` exports), which are bound to the
// REAL `requireSession()`. This file does, for all 9 exports.
//
// What is real here: the exported `action(handler)` binding, `requireSession()`
// / `resolveSession()`, Better Auth cookie verification and session lookup
// (test-only sessions, DP8, signed with the instance secret), the domain
// re-check, the handlers, the data layer, `authorize()`, the DB (PGlite).
// Framework seams replaced (same as tests/integration/uploads.test.ts):
// - `next/headers` (no Next request scope in Vitest) → the request's headers;
// - `getAuth` → the test auth instance on the per-test database;
// - `getDataContext` → the per-test database (userId still from the session);
// - `next/cache` revalidatePath → spy.
// Blob server SDK is mocked (SIMULATED) only to prove no denied call reaches it.
//
// Auth mode: SIMULATED (test-only sessions). No real Google login.
// ============================================================================

vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/blob")>();
  return { ...actual, head: vi.fn(), get: vi.fn(), del: vi.fn() };
});
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  getAuth: vi.fn(),
}));
vi.mock("@/server/data/context", () => ({ getDataContext: vi.fn() }));

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import {
  addMemberAction,
  changeMemberRoleAction,
  removeMemberAction,
} from "@/app/(app)/w/[workspaceId]/members/actions";
import { createPageAction, savePageAction, trashPageAction } from "@/app/(app)/w/[workspaceId]/p/actions";
import { deleteAttachmentAction, registerUploadAction } from "@/app/(app)/w/[workspaceId]/p/attachment-actions";
import { createWorkspaceAction } from "@/app/(app)/workspace-actions";
import { uploadPathPrefix } from "@/lib/attachment-rules";
import { getAuth } from "@/server/auth";
import { getDataContext } from "@/server/data/context";
import { membership, page, user } from "@/server/db/schema";
import { SIMULATED_BLOB_TOKEN } from "../support/blob-sim";
import { snapshotAppTables, type Fixtures, type FixtureUserKey } from "../support/fixtures";
import { useFixtureDb } from "../support/fixture-db";
import { createTestAuth, loginExistingUser, type TestAuth } from "../support/test-auth";

type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
type ActionCall = (fx: Fixtures) => Promise<Result>;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

// Every exported server action, invoked the way a forged POST would: arbitrary
// ids chosen by the caller, all targeting W1 (alice Owner, bob Editor, carol Viewer).
const W1_ACTIONS: ReadonlyArray<readonly [string, ActionCall]> = [
  ["createWorkspaceAction", () => createWorkspaceAction(null, form({ name: "QA forged workspace" }))],
  [
    "addMemberAction",
    (fx) => addMemberAction(null, form({ workspaceId: fx.workspaces.w1.id, email: fx.users.outsider.email, role: "owner" })),
  ],
  [
    "changeMemberRoleAction",
    (fx) => changeMemberRoleAction(null, form({ membershipId: fx.memberships["carol:w1"], role: "owner" })),
  ],
  ["removeMemberAction", (fx) => removeMemberAction(null, form({ membershipId: fx.memberships["bob:w1"] }))],
  ["createPageAction", (fx) => createPageAction(null, form({ workspaceId: fx.workspaces.w1.id, title: "QA forged page" }))],
  [
    "savePageAction",
    (fx) => savePageAction({ pageId: fx.pages.w1[0].id, workspaceId: fx.workspaces.w1.id, title: "QA hijacked title" }),
  ],
  [
    // DP13: the former hard-delete action was replaced by Move to Trash.
    "trashPageAction",
    (fx) => trashPageAction({ pageId: fx.pages.w1[0].id, workspaceId: fx.workspaces.w1.id }),
  ],
  [
    "registerUploadAction",
    (fx) =>
      registerUploadAction({
        pageId: fx.pages.w1[0].id,
        pathname: `${uploadPathPrefix(fx.workspaces.w1.id, fx.pages.w1[0].id)}qa-forged.pdf`,
        displayName: "qa-forged.pdf",
      }),
  ],
  ["deleteAttachmentAction", (fx) => deleteAttachmentAction(null, form({ attachmentId: fx.attachments.w1.id }))],
];

// Workspace-scoped write actions (createWorkspace is excluded: P5 lets any
// authenticated user create a workspace).
const W1_SCOPED_WRITES = W1_ACTIONS.filter(([name]) => name !== "createWorkspaceAction");

// The same actions aimed at W2 (alice: Viewer there; bob: not a member), with
// W1 ids substituted into the payload where the action accepts them (AC-38).
const W2_ACTIONS_WITH_SUBSTITUTION: ReadonlyArray<readonly [string, ActionCall]> = [
  [
    "addMemberAction (W2)",
    (fx) => addMemberAction(null, form({ workspaceId: fx.workspaces.w2.id, email: fx.users.bob.email, role: "owner" })),
  ],
  [
    "changeMemberRoleAction (W2 membership, W1 context)",
    (fx) =>
      changeMemberRoleAction(
        null,
        form({ membershipId: fx.memberships["alice:w2"], role: "owner", workspaceId: fx.workspaces.w1.id }),
      ),
  ],
  [
    "removeMemberAction (W2 membership, W1 context)",
    (fx) => removeMemberAction(null, form({ membershipId: fx.memberships["dave:w2"], workspaceId: fx.workspaces.w1.id })),
  ],
  ["createPageAction (W2)", (fx) => createPageAction(null, form({ workspaceId: fx.workspaces.w2.id, title: "QA injected" }))],
  [
    "savePageAction (W2 page, W2 route)",
    (fx) => savePageAction({ pageId: fx.pages.w2[0].id, workspaceId: fx.workspaces.w2.id, title: "QA hijacked" }),
  ],
  [
    "trashPageAction (W2 page, W2 route)",
    (fx) => trashPageAction({ pageId: fx.pages.w2[0].id, workspaceId: fx.workspaces.w2.id }),
  ],
  [
    "registerUploadAction (W2 page)",
    (fx) =>
      registerUploadAction({
        pageId: fx.pages.w2[0].id,
        pathname: `${uploadPathPrefix(fx.workspaces.w2.id, fx.pages.w2[0].id)}qa.pdf`,
        displayName: "qa.pdf",
        workspaceId: fx.workspaces.w1.id,
      }),
  ],
  [
    "deleteAttachmentAction (W2 attachment, W1 context)",
    (fx) => deleteAttachmentAction(null, form({ attachmentId: fx.attachments.w2.id, workspaceId: fx.workspaces.w1.id })),
  ],
];

describe("QA: the REAL exported server actions (action() + requireSession) with forged input", () => {
  const t = useFixtureDb();
  let auth: TestAuth;

  beforeAll(() => {
    vi.stubEnv("ALLOWED_GOOGLE_HD", "allowed.test");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", SIMULATED_BLOB_TOKEN);
    vi.stubEnv("UPLOAD_MAX_BYTES", "");
    vi.stubEnv("UPLOAD_ALLOWED_TYPES", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("VERCEL_ENV", "");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    auth = createTestAuth(t.db);
    vi.mocked(getAuth).mockReset().mockResolvedValue(auth as never);
    vi.mocked(getDataContext)
      .mockReset()
      .mockImplementation(async (session: { userId: string }) => ({ db: t.db, userId: session.userId }));
    vi.mocked(headers).mockReset();
    vi.mocked(revalidatePath).mockClear();
    vi.mocked(head).mockReset();
    vi.mocked(get).mockReset();
    vi.mocked(del).mockReset().mockResolvedValue(undefined);
  });

  /** Point the mocked `next/headers` at a request carrying `cookie` (or none). */
  function requestWith(cookie: string | null) {
    vi.mocked(headers).mockResolvedValue(new Headers(cookie ? { cookie } : {}) as never);
  }

  async function cookieFor(who: FixtureUserKey): Promise<string> {
    const login = await loginExistingUser(auth, t.fx.users[who].id);
    return `${login.cookie.name}=${login.cookie.value}`;
  }

  /** Denied: typed error result, no foreign data, 0 rows changed, no revalidation, no Blob call. */
  async function expectDenied(call: ActionCall, code: string, { handlerMayRun }: { handlerMayRun: boolean }) {
    const before = await snapshotAppTables(t.db);
    const result = await call(t.fx);

    expect(result).toEqual({ ok: false, error: { code, message: expect.any(String) } });
    const text = JSON.stringify(result);
    for (const w of Object.values(t.fx.workspaces)) expect(text).not.toContain(w.name);
    for (const p of Object.values(t.fx.pages).flat()) expect(text).not.toContain(p.title);
    for (const a of Object.values(t.fx.attachments)) {
      expect(text).not.toContain(a.displayName);
      expect(text).not.toContain(a.blobPathname);
    }
    expect(await snapshotAppTables(t.db)).toEqual(before);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    if (!handlerMayRun) {
      // Without a valid session the handler must never run: it is the only
      // caller of getDataContext.
      expect(getDataContext).not.toHaveBeenCalled();
    }
  }

  describe("essential check 2: no valid session → UNAUTHENTICATED, handler never runs, 0 rows", () => {
    it.each(W1_ACTIONS)("%s without any cookie", async (_name, call) => {
      requestWith(null);
      await expectDenied(call, "UNAUTHENTICATED", { handlerMayRun: false });
    });

    it.each(W1_ACTIONS)("%s with a forged session cookie", async (_name, call) => {
      requestWith("better-auth.session_token=forged-token.forged-signature");
      await expectDenied(call, "UNAUTHENTICATED", { handlerMayRun: false });
    });

    it.each(W1_ACTIONS)("%s with the cookie of a session that was signed out (alice)", async (_name, call) => {
      const cookie = await cookieFor("alice");
      await auth.api.signOut({ headers: new Headers({ cookie }) });
      requestWith(cookie);
      await expectDenied(call, "UNAUTHENTICATED", { handlerMayRun: false });
    });

    it.each(W1_ACTIONS)("%s with a live session whose user left the allowed domain (alice)", async (_name, call) => {
      const cookie = await cookieFor("alice");
      await t.db.update(user).set({ googleHd: "other.test" }).where(eq(user.id, t.fx.users.alice.id));
      requestWith(cookie);
      await expectDenied(call, "UNAUTHENTICATED", { handlerMayRun: false });
    });
  });

  describe("essential check 6: server-side enforcement with a VALID session (hidden buttons are irrelevant)", () => {
    it.each(W1_SCOPED_WRITES)("%s as carol (Viewer of W1) → FORBIDDEN, 0 rows", async (_name, call) => {
      requestWith(await cookieFor("carol"));
      await expectDenied(call, "FORBIDDEN", { handlerMayRun: true });
    });

    it.each(W1_SCOPED_WRITES.filter(([name]) => name.startsWith("add") || name.startsWith("change") || name.startsWith("remove")))(
      "%s as bob (Editor of W1: no member management) → FORBIDDEN, 0 rows",
      async (_name, call) => {
        requestWith(await cookieFor("bob"));
        await expectDenied(call, "FORBIDDEN", { handlerMayRun: true });
      },
    );

    it.each(W1_SCOPED_WRITES.flatMap(([name, call]) => (["outsider", "dave"] as const).map((who) => [name, who, call] as const)))(
      "%s as %s (not a member of W1) → NOT_FOUND, 0 rows",
      async (_name, who, call) => {
        requestWith(await cookieFor(who));
        await expectDenied(call, "NOT_FOUND", { handlerMayRun: true });
      },
    );
  });

  describe("essential checks 4/5: alice is Owner of W1 but only Viewer of W2; bob is not in W2", () => {
    it.each(W2_ACTIONS_WITH_SUBSTITUTION)("%s as alice → FORBIDDEN (W2 role applies), 0 rows", async (_name, call) => {
      requestWith(await cookieFor("alice"));
      await expectDenied(call, "FORBIDDEN", { handlerMayRun: true });
    });

    it.each(W2_ACTIONS_WITH_SUBSTITUTION)("%s as bob → NOT_FOUND, 0 rows", async (_name, call) => {
      requestWith(await cookieFor("bob"));
      await expectDenied(call, "NOT_FOUND", { handlerMayRun: true });
    });

    it("savePageAction: a W2 page under the W1 route as dave (Owner of W2) → NOT_FOUND, 0 rows", async () => {
      requestWith(await cookieFor("dave"));
      await expectDenied(
        (fx) => savePageAction({ pageId: fx.pages.w2[0].id, workspaceId: fx.workspaces.w1.id, title: "QA" }),
        "NOT_FOUND",
        { handlerMayRun: true },
      );
    });
  });

  describe("controls: the same harness reaches the handlers, so the denials above are meaningful", () => {
    it("bob (Editor) saves a W1 page through savePageAction: ok, row updated, author from the session", async () => {
      requestWith(await cookieFor("bob"));
      const result = await savePageAction({
        pageId: t.fx.pages.w1[0].id,
        workspaceId: t.fx.workspaces.w1.id,
        title: "QA saved title",
        updatedBy: t.fx.users.dave.id,
      });
      expect(result).toMatchObject({ ok: true, data: { title: "QA saved title" } });
      const [row] = await t.db.select().from(page).where(eq(page.id, t.fx.pages.w1[0].id));
      expect(row).toMatchObject({ title: "QA saved title", updatedBy: t.fx.users.bob.id });
      expect(getDataContext).toHaveBeenCalledWith(expect.objectContaining({ userId: t.fx.users.bob.id }));
    });

    it("alice (Owner) adds outsider to W1 through addMemberAction: ok, one new membership", async () => {
      requestWith(await cookieFor("alice"));
      const result = await addMemberAction(
        null,
        form({ workspaceId: t.fx.workspaces.w1.id, email: t.fx.users.outsider.email, role: "viewer" }),
      );
      expect(result).toEqual({ ok: true, data: { email: t.fx.users.outsider.email, role: "viewer" } });
      const rows = await t.db.select().from(membership).where(eq(membership.userId, t.fx.users.outsider.id));
      expect(rows.map((r) => r.workspaceId)).toEqual([t.fx.workspaces.w1.id]);
    });

    it("alice (Owner of W1) deletes the W1 attachment through deleteAttachmentAction: ok, del() called (SIMULATED)", async () => {
      requestWith(await cookieFor("alice"));
      const result = await deleteAttachmentAction(null, form({ attachmentId: t.fx.attachments.w1.id }));
      expect(result).toEqual({ ok: true, data: { id: t.fx.attachments.w1.id } });
      expect(del).toHaveBeenCalledWith([t.fx.attachments.w1.blobPathname], { token: SIMULATED_BLOB_TOKEN });
    });
  });
});
