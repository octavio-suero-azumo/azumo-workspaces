import { del, get, head } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// ============================================================================
// Uploads NOT configured (no BLOB_READ_WRITE_TOKEN; the real state until P4).
//
// Expected (fail closed, rest of the app keeps working):
// - every upload/download entry point answers 503 "Uploads are not
//   configured", but only AFTER session (401) and authorization (403/404), so
//   the answer never depends on configuration for pages the caller can't use;
// - attachment and page deletion still work (rows removed; the blob step is
//   skipped and logged);
// - no Blob SDK call is ever made. `@vercel/blob` is mocked ONLY to assert
//   that; nothing is simulated as succeeding.
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

import { registerUploadHandler } from "@/app/(app)/w/[workspaceId]/p/attachment-handlers";
import { GET as downloadRoute } from "@/app/api/files/[attachmentId]/route";
import { POST as uploadTokenRoute } from "@/app/api/uploads/route";
import { UPLOADS_NOT_CONFIGURED_MESSAGE, uploadPathPrefix } from "@/lib/attachment-rules";
import { createActionWrapper } from "@/server/action";
import { getAuth } from "@/server/auth";
import { deleteAttachment, listAttachments, registerUpload } from "@/server/data/attachments";
import { getDataContext } from "@/server/data/context";
import { createPage, getPage, listPages, restorePage, trashPage } from "@/server/data/pages";
import { attachment, page } from "@/server/db/schema";
import { ServiceUnavailableError } from "@/server/errors";
import { getUploadSettings } from "@/server/uploads/config";
import { snapshotAppTables, type FixtureUserKey } from "../support/fixtures";
import { useFixtureDb } from "../support/fixture-db";
import { createTestAuth, loginExistingUser, type TestAuth } from "../support/test-auth";

const BASE = "http://localhost:3000";

describe("uploads not configured (no BLOB_READ_WRITE_TOKEN)", () => {
  const t = useFixtureDb();
  let auth: TestAuth;
  let consoleWarn: MockInstance<typeof console.warn>;

  beforeAll(() => {
    vi.stubEnv("ALLOWED_GOOGLE_HD", "allowed.test");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
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
    vi.mocked(getAuth).mockResolvedValue(auth as never);
    vi.mocked(getDataContext).mockImplementation(async (session: { userId: string }) => ({
      db: t.db,
      userId: session.userId,
    }));
    vi.mocked(head).mockReset();
    vi.mocked(get).mockReset();
    vi.mocked(del).mockReset();
    vi.mocked(revalidatePath).mockClear();
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Not configured means the Blob SDK is never reached.
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  const w1Page = () => t.fx.pages.w1[0].id;
  const w1Pathname = () => `${uploadPathPrefix(t.fx.workspaces.w1.id, w1Page())}report.pdf`;

  async function cookieFor(who: FixtureUserKey): Promise<string> {
    const login = await loginExistingUser(auth, t.fx.users[who].id);
    return `${login.cookie.name}=${login.cookie.value}`;
  }

  async function requestToken(who: FixtureUserKey | null) {
    const cookie = who ? await cookieFor(who) : undefined;
    const request = new Request(`${BASE}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({
        type: "blob.generate-client-token",
        payload: {
          pathname: w1Pathname(),
          clientPayload: JSON.stringify({ pageId: w1Page(), size: 100, contentType: "application/pdf" }),
          multipart: false,
        },
      }),
    });
    vi.mocked(headers).mockResolvedValue(request.headers as never);
    return uploadTokenRoute(request);
  }

  async function download(who: FixtureUserKey | null, attachmentId: string) {
    const cookie = who ? await cookieFor(who) : undefined;
    const request = new Request(`${BASE}/api/files/${attachmentId}`, { headers: cookie ? { cookie } : {} });
    vi.mocked(headers).mockResolvedValue(request.headers as never);
    return downloadRoute(request, { params: Promise.resolve({ attachmentId }) });
  }

  async function errorOf(response: Response) {
    return { status: response.status, body: (await response.json()) as { error: { code: string; message: string } } };
  }

  it("the UI settings report uploads as disabled, with the P8 limits", () => {
    expect(getUploadSettings()).toMatchObject({ enabled: false, maxBytes: 10 * 1024 * 1024 });
  });

  describe("POST /api/uploads", () => {
    it("bob (Editor) → 503 'Uploads are not configured', no token", async () => {
      const { status, body } = await errorOf(await requestToken("bob"));
      expect(status).toBe(503);
      expect(body).toEqual({ error: { code: "UNAVAILABLE", message: UPLOADS_NOT_CONFIGURED_MESSAGE } });
    });

    it("authorization still comes first: carol (Viewer) 403, outsider 404, no session 401", async () => {
      expect((await errorOf(await requestToken("carol"))).status).toBe(403);
      expect((await errorOf(await requestToken("outsider"))).status).toBe(404);
      expect((await errorOf(await requestToken(null))).status).toBe(401);
    });
  });

  describe("GET /api/files/{id}", () => {
    it("carol (member) → 503; outsider 404; no session 401", async () => {
      const id = t.fx.attachments.w1.id;
      const member = await errorOf(await download("carol", id));
      expect(member).toEqual({ status: 503, body: { error: { code: "UNAVAILABLE", message: UPLOADS_NOT_CONFIGURED_MESSAGE } } });
      expect((await errorOf(await download("outsider", id))).status).toBe(404);
      expect((await errorOf(await download(null, id))).status).toBe(401);
    });
  });

  describe("registerUpload", () => {
    it("bob → ServiceUnavailableError, 0 rows; through action() → typed UNAVAILABLE result", async () => {
      const before = await snapshotAppTables(t.db);
      const input = { pageId: w1Page(), pathname: w1Pathname(), displayName: "report.pdf" };
      await expect(registerUpload(t.as("bob"), input)).rejects.toBeInstanceOf(ServiceUnavailableError);

      const wrapped = createActionWrapper(async () => ({ userId: t.fx.users.bob.id }))(registerUploadHandler);
      await expect(wrapped(input)).resolves.toEqual({
        ok: false,
        error: { code: "UNAVAILABLE", message: UPLOADS_NOT_CONFIGURED_MESSAGE },
      });
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });
  });

  describe("the rest of the app keeps working", () => {
    it("pages and attachment lists load; pages can be created", async () => {
      await expect(getPage(t.as("carol"), { pageId: w1Page() })).resolves.toMatchObject({ id: w1Page() });
      await expect(listAttachments(t.as("carol"), { pageId: w1Page() })).resolves.toHaveLength(1);
      const created = await createPage(t.as("bob"), { workspaceId: t.fx.workspaces.w1.id, title: "Still works" });
      expect((await listPages(t.as("bob"), t.fx.workspaces.w1.id)).map((p) => p.id)).toContain(created.id);
    });

    it("deleting an attachment removes the row; the blob step is skipped and logged", async () => {
      await deleteAttachment(t.as("bob"), { attachmentId: t.fx.attachments.w1.id });
      expect(await t.db.select().from(attachment).where(eq(attachment.id, t.fx.attachments.w1.id))).toEqual([]);
      expect(consoleWarn).toHaveBeenCalledWith(
        "[uploads] BLOB_READ_WRITE_TOKEN is not configured; blobs were not deleted",
        { count: 1 },
      );
    });

    it("trashing and restoring a page with attachments works without Blob (DP13: no blob step at all)", async () => {
      await trashPage(t.as("bob"), { pageId: w1Page() });
      const [trashed] = await t.db.select().from(page).where(eq(page.id, w1Page()));
      expect(trashed.deletedAt).toBeInstanceOf(Date);
      expect(await t.db.select().from(attachment).where(eq(attachment.pageId, w1Page()))).toHaveLength(1);
      await restorePage(t.as("bob"), { pageId: w1Page() });
      const [restored] = await t.db.select().from(page).where(eq(page.id, w1Page()));
      expect(restored.deletedAt).toBeNull();
      expect(consoleWarn).not.toHaveBeenCalled();
    });
  });
});
