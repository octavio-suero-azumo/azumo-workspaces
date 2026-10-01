import { BlobNotFoundError, del, get, head } from "@vercel/blob";
import { getPayloadFromClientToken } from "@vercel/blob/client";
import { count, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// ============================================================================
// Increment E (T-13, T-15, T-16) — SIMULATED Blob.
//
// There is NO real Blob store or token (P4 pending). `@vercel/blob` (server
// SDK: head/get/del) is replaced with vi.mock; `@vercel/blob/client`'s
// `handleUpload` is the REAL SDK, signing client tokens locally (HMAC) with an
// obviously fake token — no network (fetch is spied and must never be
// called). Real Blob behaviour (constraints enforced by the service, blob
// really deleted) is manual TC-43.
//
// Sessions are REAL test-only sessions (DP8): `requireSession()` runs for real
// and validates a signed Better Auth cookie. Only two framework seams are
// replaced: `next/headers` (no Next request scope in Vitest) and `getAuth`
// (returns the test auth instance on the per-test database).
//
// TC-33 (AC-22), TC-34 (AC-23), TC-35 (AC-24), TC-36 (AC-26), TC-29 blob part
// (AC-28), TC-21 (d) (AC-38), AC-20 (attachment list).
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

import { deleteAttachmentHandler, registerUploadHandler } from "@/app/(app)/w/[workspaceId]/p/attachment-handlers";
import { GET as downloadRoute } from "@/app/api/files/[attachmentId]/route";
import { POST as uploadTokenRoute } from "@/app/api/uploads/route";
import { ATTACHMENT_DISPLAY_NAME_MAX, fileTooLargeMessage, FILE_TYPE_NOT_ALLOWED_MESSAGE, uploadPathPrefix } from "@/lib/attachment-rules";
import { createActionWrapper } from "@/server/action";
import { getAuth } from "@/server/auth";
import {
  ALREADY_ATTACHED_MESSAGE,
  authorizeUploadRequest,
  deleteAttachment,
  getAttachmentDownload,
  listAttachments,
  registerUpload,
  UPLOAD_NOT_FOUND_MESSAGE,
} from "@/server/data/attachments";
import { getDataContext } from "@/server/data/context";
import { restorePage, trashPage } from "@/server/data/pages";
import { attachment, page } from "@/server/db/schema";
import { DEFAULT_UPLOAD_ALLOWED_TYPES, DEFAULT_UPLOAD_MAX_BYTES } from "@/server/env";
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from "@/server/errors";
import { simulatedGet, simulatedHead, SIMULATED_BLOB_HOST, SIMULATED_BLOB_TOKEN } from "../support/blob-sim";
import { snapshotAppTables, type FixtureUserKey } from "../support/fixtures";
import { useFixtureDb } from "../support/fixture-db";
import { createTestAuth, loginExistingUser, type TestAuth } from "../support/test-auth";

type ErrorClass =
  | typeof ForbiddenError
  | typeof NotFoundError
  | typeof ValidationError
  | typeof ConflictError
  | typeof UnauthenticatedError;

const BASE = "http://localhost:3000";

describe("uploads (SIMULATED Blob): token route, registerUpload, download, delete", () => {
  const t = useFixtureDb();
  let auth: TestAuth;
  let fetchSpy: MockInstance<typeof fetch>;
  let consoleError: MockInstance<typeof console.error>;
  let consoleWarn: MockInstance<typeof console.warn>;

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
    vi.mocked(getAuth).mockResolvedValue(auth as never);
    vi.mocked(getDataContext).mockImplementation(async (session: { userId: string }) => ({
      db: t.db,
      userId: session.userId,
    }));
    vi.mocked(head).mockReset();
    vi.mocked(get).mockReset();
    vi.mocked(del).mockReset().mockResolvedValue(undefined);
    vi.mocked(revalidatePath).mockClear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      throw new Error(`unexpected network call in a SIMULATED test: ${String(input)}`);
    });
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    // SIMULATED means no network at all: the Blob SDK was either mocked or signed locally.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  // ---------------------------------------------------------------- helpers

  const w1 = () => t.fx.workspaces.w1.id;
  const w2 = () => t.fx.workspaces.w2.id;
  const w1Page = () => t.fx.pages.w1[0].id;
  const w1OtherPage = () => t.fx.pages.w1[1].id;
  const w2Page = () => t.fx.pages.w2[0].id;
  const w1Pathname = (file = "report.pdf", pageId = w1Page()) => `${uploadPathPrefix(w1(), pageId)}${file}`;
  const w2Pathname = (file = "report.pdf") => `${uploadPathPrefix(w2(), w2Page())}${file}`;

  async function cookieFor(who: FixtureUserKey): Promise<string> {
    const login = await loginExistingUser(auth, t.fx.users[who].id);
    return `${login.cookie.name}=${login.cookie.value}`;
  }

  /** Point the mocked `next/headers` at this request, as Next would. */
  function bindRequest(request: Request): Request {
    vi.mocked(headers).mockResolvedValue(request.headers as never);
    return request;
  }

  function tokenBody(options: {
    pathname: string;
    pageId?: string;
    size?: number;
    contentType?: string;
    clientPayload?: string | null;
  }) {
    const clientPayload =
      options.clientPayload !== undefined
        ? options.clientPayload
        : JSON.stringify({
            pageId: options.pageId ?? w1Page(),
            size: options.size ?? 1234,
            contentType: options.contentType ?? "application/pdf",
          });
    return { type: "blob.generate-client-token", payload: { pathname: options.pathname, clientPayload, multipart: false } };
  }

  async function requestToken(who: FixtureUserKey | null, body: unknown, extraHeaders: Record<string, string> = {}) {
    const cookie = who ? await cookieFor(who) : undefined;
    const request = bindRequest(
      new Request(`${BASE}/api/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extraHeaders },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    return uploadTokenRoute(request);
  }

  async function download(who: FixtureUserKey | null, attachmentId: string, cookieOverride?: string) {
    const cookie = cookieOverride ?? (who ? await cookieFor(who) : undefined);
    const request = bindRequest(
      new Request(`${BASE}/api/files/${attachmentId}`, { headers: cookie ? { cookie } : {} }),
    );
    return downloadRoute(request, { params: Promise.resolve({ attachmentId }) });
  }

  /** Every fixture value that must never leak into a denial. */
  function foreignStrings(): string[] {
    const { workspaces, pages, attachments } = t.fx;
    return [
      ...Object.values(workspaces).map((w) => w.name),
      ...Object.values(pages).flatMap((list) => list.map((p) => p.title)),
      ...Object.values(attachments).flatMap((a) => [a.displayName, a.blobPathname]),
    ];
  }

  function expectNoRawBlobData(text: string) {
    expect(text).not.toContain(SIMULATED_BLOB_HOST);
    expect(text).not.toContain("vercel-storage.com");
    expect(text).not.toContain("NOT-A-REAL-TOKEN");
    expect(text).not.toMatch(/ws\/[0-9a-f-]{36}\/pg\//);
  }

  async function expectErrorResponse(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: { code, message: expect.any(String) } });
    for (const value of foreignStrings()) expect(text).not.toContain(value);
    expectNoRawBlobData(text);
    return JSON.parse(text) as { error: { code: string; message: string } };
  }

  async function expectDeniedUnchanged(call: () => Promise<unknown>, errorClass: ErrorClass) {
    const before = await snapshotAppTables(t.db);
    const error = await call().then(
      () => {
        throw new Error("expected the call to be denied, but it succeeded");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(errorClass);
    const text = JSON.stringify({ message: (error as Error).message, ...(error as object) });
    for (const value of foreignStrings()) expect(text).not.toContain(value);
    expect(await snapshotAppTables(t.db)).toEqual(before);
    return error as Error;
  }

  const attachmentCount = async () => (await t.db.select({ n: count() }).from(attachment))[0].n;

  // ------------------------------------------------ AC-22: token issuance

  describe("TC-33 / AC-22: POST /api/uploads issues a token only to Owner/Editor of the page", () => {
    it("bob (Editor) gets a client token bound to his pathname, with the P8 limits and a random suffix", async () => {
      const pathname = w1Pathname("Quarterly-report.pdf");
      const before = await snapshotAppTables(t.db);
      const response = await requestToken("bob", tokenBody({ pathname }));

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      const json = JSON.parse(text) as { type: string; clientToken: string };
      expect(json.type).toBe("blob.generate-client-token");
      expect(json.clientToken.startsWith("vercel_blob_client_simulatedstore_")).toBe(true);

      const claims = getPayloadFromClientToken(json.clientToken);
      expect(claims).toMatchObject({
        pathname,
        maximumSizeInBytes: DEFAULT_UPLOAD_MAX_BYTES,
        allowedContentTypes: [...DEFAULT_UPLOAD_ALLOWED_TYPES],
        addRandomSuffix: true,
        allowOverwrite: false,
      });
      expect(claims.maximumSizeInBytes).toBe(10 * 1024 * 1024);
      expect(claims).not.toHaveProperty("onUploadCompleted");
      expect(claims.validUntil).toBeGreaterThan(Date.now());
      expect(claims.validUntil).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000 + 1000);

      // The response carries no blob URL and never the read-write token.
      expectNoRawBlobData(text);
      expect(Buffer.from(json.clientToken.split("_")[4] ?? "", "base64").toString()).not.toContain("NOT-A-REAL-TOKEN");
      // Issuing a token writes nothing and touches no blob.
      expect(await snapshotAppTables(t.db)).toEqual(before);
      expect(head).not.toHaveBeenCalled();
    });

    it("alice (Owner) gets a token too", async () => {
      const response = await requestToken("alice", tokenBody({ pathname: w1Pathname() }));
      expect(response.status).toBe(200);
    });

    it("carol (Viewer) → 403, no token", async () => {
      const body = await expectErrorResponse(
        await requestToken("carol", tokenBody({ pathname: w1Pathname() })),
        403,
        "FORBIDDEN",
      );
      expect(body).not.toHaveProperty("clientToken");
    });

    it.each(["outsider", "dave", "erin"] as const)("%s (non-member of W1) → 404, no token, no W1 data", async (who) => {
      await expectErrorResponse(await requestToken(who, tokenBody({ pathname: w1Pathname() })), 404, "NOT_FOUND");
    });

    it("alice on a W2 page, where she is a Viewer → 403 (role never carries over, AC-37)", async () => {
      await expectErrorResponse(
        await requestToken("alice", tokenBody({ pathname: w2Pathname(), pageId: w2Page() })),
        403,
        "FORBIDDEN",
      );
    });

    it("no session → 401; a forged session cookie → 401", async () => {
      await expectErrorResponse(await requestToken(null, tokenBody({ pathname: w1Pathname() })), 401, "UNAUTHENTICATED");
      await expectErrorResponse(
        await requestToken(null, tokenBody({ pathname: w1Pathname() }), {
          cookie: "better-auth.session_token=forged.signature",
        }),
        401,
        "UNAUTHENTICATED",
      );
    });

    it("a non-member gets 404 even for an oversized file (authorization first)", async () => {
      await expectErrorResponse(
        await requestToken("outsider", tokenBody({ pathname: w1Pathname(), size: DEFAULT_UPLOAD_MAX_BYTES + 1 })),
        404,
        "NOT_FOUND",
      );
    });
  });

  describe("TC-33 / AC-38 / RV-08: the requested pathname must be under ws/{workspaceId}/pg/{pageId}/ of the authorized page", () => {
    it.each([
      ["another workspace's page (W2)", () => w2Pathname("x.pdf")],
      ["another page of the same workspace", () => w1Pathname("x.pdf", w1OtherPage())],
      ["W1 workspace with a W2 page id", () => `${uploadPathPrefix(t.fx.workspaces.w1.id, t.fx.pages.w2[0].id)}x.pdf`],
      ["an upper-cased copy of the right prefix", () => w1Pathname("x.pdf").toUpperCase()],
      ["no prefix at all", () => "x.pdf"],
      ["a prefix-like path elsewhere", () => `other/${w1Pathname("x.pdf")}`],
    ])("%s → 403, no token", async (_label, pathname) => {
      await expectErrorResponse(await requestToken("bob", tokenBody({ pathname: pathname() })), 403, "FORBIDDEN");
    });

    it.each([
      ["a traversal after the prefix", () => w1Pathname(`../../ws/${t.fx.workspaces.w2.id}/x.pdf`)],
      ["a nested folder", () => w1Pathname("sub/x.pdf")],
      ["an empty file name", () => w1Pathname("")],
      ["a hidden file", () => w1Pathname(".env")],
      ["spaces", () => w1Pathname("my file.pdf")],
    ])("%s → 400, no token", async (_label, pathname) => {
      await expectErrorResponse(await requestToken("bob", tokenBody({ pathname: pathname() })), 400, "VALIDATION");
    });
  });

  describe("TC-34 / AC-23 at the token: declared size and type (P8: 10 MB, allowlist)", () => {
    it("exactly 10 MB is accepted; one byte more → 400 with the limit in the message", async () => {
      expect((await requestToken("bob", tokenBody({ pathname: w1Pathname(), size: DEFAULT_UPLOAD_MAX_BYTES }))).status).toBe(200);
      const body = await expectErrorResponse(
        await requestToken("bob", tokenBody({ pathname: w1Pathname(), size: DEFAULT_UPLOAD_MAX_BYTES + 1 })),
        400,
        "VALIDATION",
      );
      expect(body.error.message).toBe(fileTooLargeMessage(DEFAULT_UPLOAD_MAX_BYTES));
    });

    it.each(["text/html", "image/svg+xml", "application/x-msdownload", "application/javascript", "application/octet-stream", ""])(
      "declared type %j → 400",
      async (contentType) => {
        const body = await expectErrorResponse(
          await requestToken("bob", tokenBody({ pathname: w1Pathname("x.bin"), contentType })),
          400,
          "VALIDATION",
        );
        expect(body.error.message).toBe(FILE_TYPE_NOT_ALLOWED_MESSAGE);
      },
    );

    it.each([...DEFAULT_UPLOAD_ALLOWED_TYPES])("declared type %s → token issued", async (contentType) => {
      expect((await requestToken("bob", tokenBody({ pathname: w1Pathname("x.bin"), contentType }))).status).toBe(200);
    });
  });

  describe("malformed token requests → 400", () => {
    it.each([
      ["invalid JSON", "{not json"],
      ["an upload-completed callback (not used; rejected)", { type: "blob.upload-completed", payload: { blob: {}, tokenPayload: null } }],
      ["a missing clientPayload", () => tokenBody({ pathname: w1Pathname(), clientPayload: null })],
      ["a clientPayload that is not JSON", () => tokenBody({ pathname: w1Pathname(), clientPayload: "pageId=1" })],
      ["a clientPayload without pageId", () => tokenBody({ pathname: w1Pathname(), clientPayload: JSON.stringify({ size: 1, contentType: "text/plain" }) })],
      ["a clientPayload array", () => tokenBody({ pathname: w1Pathname(), clientPayload: "[]" })],
      ["a clientPayload without size", () => tokenBody({ pathname: w1Pathname(), clientPayload: JSON.stringify({ pageId: w1Page(), contentType: "text/plain" }) })],
      ["an oversized body", () => ({ ...tokenBody({ pathname: w1Pathname() }), padding: "x".repeat(20_000) })],
    ])("%s", async (_label, body) => {
      const payload = typeof body === "function" ? body() : body;
      await expectErrorResponse(await requestToken("bob", payload), 400, "VALIDATION");
    });
  });

  // ------------------------------------------- AC-22/23/38: registerUpload

  describe("TC-34 / AC-22 / AC-23: registerUpload re-authorizes and checks the REAL blob with head()", () => {
    it("bob registers an uploaded blob: the row uses head()'s size/type; the result has no URL or pathname", async () => {
      const pathname = w1Pathname("Quarterly-report-AbC123xyz.pdf");
      vi.mocked(head).mockResolvedValue(simulatedHead(pathname, { size: 5000, contentType: "application/pdf" }));

      const created = await registerUpload(t.as("bob"), {
        pageId: w1Page(),
        pathname,
        displayName: "  Quarterly report.pdf ",
      });

      expect(head).toHaveBeenCalledTimes(1);
      expect(head).toHaveBeenCalledWith(pathname, { token: SIMULATED_BLOB_TOKEN });
      expect(del).not.toHaveBeenCalled();
      expect(created).toMatchObject({
        pageId: w1Page(),
        workspaceId: w1(),
        displayName: "Quarterly report.pdf",
        contentType: "application/pdf",
        sizeBytes: 5000,
      });
      expect(Object.keys(created).sort()).toEqual(
        ["contentType", "createdAt", "displayName", "id", "pageId", "sizeBytes", "workspaceId"].sort(),
      );
      expectNoRawBlobData(JSON.stringify(created));

      const [row] = await t.db.select().from(attachment).where(eq(attachment.id, created.id));
      expect(row).toMatchObject({
        pageId: w1Page(),
        workspaceId: w1(),
        kind: "upload",
        blobPathname: pathname,
        contentType: "application/pdf",
        sizeBytes: 5000,
        createdBy: t.fx.users.bob.id,
      });
    });

    it("the stored type is head()'s type, normalized (parameters dropped)", async () => {
      const pathname = w1Pathname("notes.txt");
      vi.mocked(head).mockResolvedValue(simulatedHead(pathname, { size: 10, contentType: "Text/Plain; charset=utf-8" }));
      const created = await registerUpload(t.as("alice"), { pageId: w1Page(), pathname, displayName: "notes.txt" });
      expect(created.contentType).toBe("text/plain");
    });

    it("AC-23: a blob over the limit (per head) is rejected AND deleted; no row", async () => {
      const pathname = w1Pathname("huge.pdf");
      vi.mocked(head).mockResolvedValue(simulatedHead(pathname, { size: DEFAULT_UPLOAD_MAX_BYTES + 1 }));
      const error = await expectDeniedUnchanged(
        () => registerUpload(t.as("bob"), { pageId: w1Page(), pathname, displayName: "huge.pdf" }),
        ValidationError,
      );
      expect(error.message).toBe(fileTooLargeMessage(DEFAULT_UPLOAD_MAX_BYTES));
      expect(del).toHaveBeenCalledWith([pathname], { token: SIMULATED_BLOB_TOKEN });
    });

    it.each(["text/html", "image/svg+xml", "application/octet-stream"])(
      "AC-23: a blob whose real type is %s is rejected AND deleted; no row",
      async (contentType) => {
        const pathname = w1Pathname("sneaky.pdf");
        vi.mocked(head).mockResolvedValue(simulatedHead(pathname, { contentType }));
        const error = await expectDeniedUnchanged(
          () => registerUpload(t.as("bob"), { pageId: w1Page(), pathname, displayName: "sneaky.pdf" }),
          ValidationError,
        );
        expect(error.message).toBe(FILE_TYPE_NOT_ALLOWED_MESSAGE);
        expect(del).toHaveBeenCalledWith([pathname], { token: SIMULATED_BLOB_TOKEN });
      },
    );

    it("a blob that does not exist (head → BlobNotFoundError) is rejected; nothing deleted, no row", async () => {
      vi.mocked(head).mockRejectedValue(new BlobNotFoundError());
      const error = await expectDeniedUnchanged(
        () => registerUpload(t.as("bob"), { pageId: w1Page(), pathname: w1Pathname("ghost.pdf"), displayName: "ghost.pdf" }),
        ValidationError,
      );
      expect(error.message).toBe(UPLOAD_NOT_FOUND_MESSAGE);
      expect(del).not.toHaveBeenCalled();
    });

    it("head() reporting a different pathname is rejected; no row", async () => {
      vi.mocked(head).mockResolvedValue(simulatedHead(w1Pathname("other.pdf")));
      await expectDeniedUnchanged(
        () => registerUpload(t.as("bob"), { pageId: w1Page(), pathname: w1Pathname("mine.pdf"), displayName: "mine.pdf" }),
        ValidationError,
      );
    });

    it("registering the same blob twice → Conflict; the existing row keeps its blob (no del)", async () => {
      const pathname = w1Pathname("twice.pdf");
      vi.mocked(head).mockResolvedValue(simulatedHead(pathname));
      await registerUpload(t.as("bob"), { pageId: w1Page(), pathname, displayName: "twice.pdf" });
      const error = await expectDeniedUnchanged(
        () => registerUpload(t.as("alice"), { pageId: w1Page(), pathname, displayName: "twice again.pdf" }),
        ConflictError,
      );
      expect(error.message).toBe(ALREADY_ATTACHED_MESSAGE);
      expect(del).not.toHaveBeenCalled();
    });

    it("the page deleted between authorization and insert → NotFound, the blob is deleted, no row", async () => {
      const pathname = w1Pathname("late.pdf");
      vi.mocked(head).mockImplementation(async () => {
        await t.db.delete(page).where(eq(page.id, w1Page()));
        return simulatedHead(pathname);
      });
      await expect(
        registerUpload(t.as("bob"), { pageId: w1Page(), pathname, displayName: "late.pdf" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(del).toHaveBeenCalledWith([pathname], { token: SIMULATED_BLOB_TOKEN });
      expect(await t.db.select().from(attachment).where(eq(attachment.blobPathname, pathname))).toEqual([]);
    });

    it("carol (Viewer) → Forbidden before any Blob call; no row", async () => {
      await expectDeniedUnchanged(
        () => registerUpload(t.as("carol"), { pageId: w1Page(), pathname: w1Pathname(), displayName: "x.pdf" }),
        ForbiddenError,
      );
      expect(head).not.toHaveBeenCalled();
    });

    it.each(["outsider", "dave", "erin"] as const)("%s (non-member) → NotFound before any Blob call; no row", async (who) => {
      await expectDeniedUnchanged(
        () => registerUpload(t.as(who), { pageId: w1Page(), pathname: w1Pathname(), displayName: "x.pdf" }),
        NotFoundError,
      );
      expect(head).not.toHaveBeenCalled();
    });

    it.each([
      ["empty", ""],
      ["only a bidi override", "‮"],
      ["not a string", 42],
      [`${ATTACHMENT_DISPLAY_NAME_MAX + 1} characters`, "n".repeat(ATTACHMENT_DISPLAY_NAME_MAX + 1)],
    ])("a display name that is %s → ValidationError before any Blob call", async (_label, displayName) => {
      await expectDeniedUnchanged(
        () => registerUpload(t.as("bob"), { pageId: w1Page(), pathname: w1Pathname(), displayName }),
        ValidationError,
      );
      expect(head).not.toHaveBeenCalled();
    });

    it(`a ${ATTACHMENT_DISPLAY_NAME_MAX}-character display name is accepted and stored sanitized`, async () => {
      const pathname = w1Pathname("long.pdf");
      vi.mocked(head).mockResolvedValue(simulatedHead(pathname));
      const name = `‮${"n".repeat(ATTACHMENT_DISPLAY_NAME_MAX - 4)}.pdf`;
      const created = await registerUpload(t.as("bob"), { pageId: w1Page(), pathname, displayName: name });
      expect(created.displayName).toBe(`${"n".repeat(ATTACHMENT_DISPLAY_NAME_MAX - 4)}.pdf`);
    });
  });

  describe("TC-21 (d) / AC-38: registerUpload with another workspace's pathname or page", () => {
    it("alice (Owner of W1) registers a ws/{W2}/… pathname on a W1 page → Forbidden, 0 rows, no Blob call", async () => {
      await expectDeniedUnchanged(
        () => registerUpload(t.as("alice"), { pageId: w1Page(), pathname: w2Pathname("x.pdf"), displayName: "x.pdf", workspaceId: w2() }),
        ForbiddenError,
      );
      expect(head).not.toHaveBeenCalled();
    });

    it("alice registers on the W2 page itself → Forbidden by her W2 role (Viewer), 0 rows", async () => {
      await expectDeniedUnchanged(
        () => registerUpload(t.as("alice"), { pageId: w2Page(), pathname: w2Pathname("x.pdf"), displayName: "x.pdf", workspaceId: w1() }),
        ForbiddenError,
      );
      expect(head).not.toHaveBeenCalled();
    });

    it("dave (Owner of W2) registers a ws/{W1}/… pathname on his W2 page → Forbidden, 0 rows", async () => {
      await expectDeniedUnchanged(
        () => registerUpload(t.as("dave"), { pageId: w2Page(), pathname: w1Pathname("x.pdf"), displayName: "x.pdf" }),
        ForbiddenError,
      );
      expect(head).not.toHaveBeenCalled();
    });

    it("bob (W1 only) registers onto the W2 page → NotFound, 0 rows", async () => {
      await expectDeniedUnchanged(
        () => registerUpload(t.as("bob"), { pageId: w2Page(), pathname: w2Pathname("x.pdf"), displayName: "x.pdf" }),
        NotFoundError,
      );
      expect(head).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------- AC-24: download

  describe("TC-35 / AC-24: GET /api/files/{id} streams the private blob to members only", () => {
    it("carol (Viewer) downloads: 200, the file bytes, attachment + private no-cache + nosniff; no blob URL anywhere", async () => {
      const file = t.fx.attachments.w1;
      vi.mocked(get).mockResolvedValue(simulatedGet(file.blobPathname, "simulated file body", "application/pdf"));

      const response = await download("carol", file.id);

      expect(response.status).toBe(200);
      expect(get).toHaveBeenCalledWith(file.blobPathname, { access: "private", token: SIMULATED_BLOB_TOKEN });
      expect(response.headers.get("cache-control")).toBe("private, no-cache");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-disposition")).toBe(
        "attachment; filename=\"W1 roadmap.pdf\"; filename*=UTF-8''W1%20roadmap.pdf",
      );
      expect(response.headers.get("content-type")).toBe(file.contentType);
      expect(response.headers.get("content-length")).toBe(String("simulated file body".length));
      expect(response.headers.get("location")).toBeNull();
      const body = await response.text();
      expect(body).toBe("simulated file body");
      expectNoRawBlobData(body);
      expectNoRawBlobData(JSON.stringify([...response.headers.entries()]));
    });

    it.each(["alice", "bob"] as const)("%s (Owner/Editor) downloads too", async (who) => {
      vi.mocked(get).mockResolvedValue(simulatedGet(t.fx.attachments.w1.blobPathname, "x"));
      expect((await download(who, t.fx.attachments.w1.id)).status).toBe(200);
    });

    it("a non-ASCII display name is sent RFC 6266-encoded", async () => {
      const pathname = w1Pathname("presupuesto.xlsx");
      vi.mocked(head).mockResolvedValue(
        simulatedHead(pathname, { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      );
      const created = await registerUpload(t.as("bob"), { pageId: w1Page(), pathname, displayName: "Presupuesto año 2026.xlsx" });
      vi.mocked(get).mockResolvedValue(simulatedGet(pathname, "x"));
      const response = await download("carol", created.id);
      expect(response.headers.get("content-disposition")).toBe(
        "attachment; filename=\"Presupuesto ano 2026.xlsx\"; filename*=UTF-8''Presupuesto%20a%C3%B1o%202026.xlsx",
      );
    });

    it.each(["outsider", "dave", "erin"] as const)("%s (non-member) → 404 without W1 data; the blob is never fetched", async (who) => {
      await expectErrorResponse(await download(who, t.fx.attachments.w1.id), 404, "NOT_FOUND");
      expect(get).not.toHaveBeenCalled();
    });

    it("no session → 401; forged cookie → 401; the blob is never fetched", async () => {
      await expectErrorResponse(await download(null, t.fx.attachments.w1.id), 401, "UNAUTHENTICATED");
      await expectErrorResponse(
        await download(null, t.fx.attachments.w1.id, "better-auth.session_token=forged.signature"),
        401,
        "UNAUTHENTICATED",
      );
      expect(get).not.toHaveBeenCalled();
    });

    it("AC-38: bob (W1 only) with W2's attachment id → 404; alice (Viewer in W2) may download it", async () => {
      await expectErrorResponse(await download("bob", t.fx.attachments.w2.id), 404, "NOT_FOUND");
      expect(get).not.toHaveBeenCalled();
      vi.mocked(get).mockResolvedValue(simulatedGet(t.fx.attachments.w2.blobPathname, "w2", "image/png"));
      expect((await download("alice", t.fx.attachments.w2.id)).status).toBe(200);
    });

    it.each([
      ["an unknown uuid", "3f2b7c1e-9a4d-4e2f-8b6a-1c2d3e4f5a6b"],
      ["a malformed id", "not-a-uuid"],
      ["a page id", "page"],
    ])("%s → 404", async (_label, id) => {
      const attachmentId = id === "page" ? w1Page() : id;
      await expectErrorResponse(await download("alice", attachmentId), 404, "NOT_FOUND");
    });

    it("a row whose blob is missing (get → null) → 404", async () => {
      vi.mocked(get).mockResolvedValue(null);
      await expectErrorResponse(await download("carol", t.fx.attachments.w1.id), 404, "NOT_FOUND");
    });

    it("a Blob failure → 500 with a generic body (no details, no URL)", async () => {
      vi.mocked(get).mockRejectedValue(new Error(`upstream failure at https://${SIMULATED_BLOB_HOST}/secret`));
      const body = await expectErrorResponse(await download("carol", t.fx.attachments.w1.id), 500, "INTERNAL");
      expect(body.error.message).toBe("Something went wrong.");
    });
  });

  describe("AC-20 / AC-24: the attachment list exposes no blob URL or pathname", () => {
    it("every member lists the page's attachments as id/name/type/size/createdAt only", async () => {
      for (const who of ["alice", "bob", "carol"] as const) {
        const list = await listAttachments(t.as(who), { pageId: w1Page() });
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
          id: t.fx.attachments.w1.id,
          displayName: "W1 roadmap.pdf",
          contentType: "application/pdf",
          sizeBytes: 2048,
        });
        expect(Object.keys(list[0]).sort()).toEqual(["contentType", "createdAt", "displayName", "id", "sizeBytes"]);
        expectNoRawBlobData(JSON.stringify(list));
      }
      expect(await listAttachments(t.as("carol"), { pageId: w1OtherPage() })).toEqual([]);
    });

    it("non-members → NotFound", async () => {
      await expectDeniedUnchanged(() => listAttachments(t.as("dave"), { pageId: w1Page() }), NotFoundError);
    });

    it("the download gate returns the pathname only server-side, and only to members", async () => {
      await expect(getAttachmentDownload(t.as("carol"), { attachmentId: t.fx.attachments.w1.id })).resolves.toMatchObject({
        blobPathname: t.fx.attachments.w1.blobPathname,
      });
      await expectDeniedUnchanged(
        () => getAttachmentDownload(t.as("bob"), { attachmentId: t.fx.attachments.w2.id }),
        NotFoundError,
      );
    });
  });

  // ------------------------------------------------------ AC-26: delete

  describe("TC-36 / AC-26: delete an attachment (row first, then del())", () => {
    it("bob (Editor) deletes: row removed, del() called with the pathname, later download → 404", async () => {
      const file = t.fx.attachments.w1;
      await expect(deleteAttachment(t.as("bob"), { attachmentId: file.id })).resolves.toEqual({
        id: file.id,
        pageId: file.pageId,
        workspaceId: w1(),
      });
      expect(await t.db.select().from(attachment).where(eq(attachment.id, file.id))).toEqual([]);
      expect(del).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledWith([file.blobPathname], { token: SIMULATED_BLOB_TOKEN });
      expect(await listAttachments(t.as("carol"), { pageId: file.pageId })).toEqual([]);
      await expectErrorResponse(await download("carol", file.id), 404, "NOT_FOUND");
      // Other workspaces' attachments are untouched.
      expect(await attachmentCount()).toBe(2);
    });

    it("alice (Owner) can delete", async () => {
      await deleteAttachment(t.as("alice"), { attachmentId: t.fx.attachments.w1.id });
      expect(del).toHaveBeenCalledWith([t.fx.attachments.w1.blobPathname], { token: SIMULATED_BLOB_TOKEN });
    });

    it("carol (Viewer) → Forbidden; row kept; del() not called", async () => {
      await expectDeniedUnchanged(() => deleteAttachment(t.as("carol"), { attachmentId: t.fx.attachments.w1.id }), ForbiddenError);
      expect(del).not.toHaveBeenCalled();
    });

    it.each(["outsider", "dave", "erin"] as const)("%s (non-member) → NotFound; del() not called", async (who) => {
      await expectDeniedUnchanged(() => deleteAttachment(t.as(who), { attachmentId: t.fx.attachments.w1.id }), NotFoundError);
      expect(del).not.toHaveBeenCalled();
    });

    it("AC-38: W2's attachment from a W1 context → alice Forbidden (Viewer in W2), bob NotFound; 0 rows", async () => {
      const target = { attachmentId: t.fx.attachments.w2.id, workspaceId: w1() };
      await expectDeniedUnchanged(() => deleteAttachment(t.as("alice"), target), ForbiddenError);
      await expectDeniedUnchanged(() => deleteAttachment(t.as("bob"), target), NotFoundError);
      expect(del).not.toHaveBeenCalled();
    });

    it("a Blob failure after the row is gone is logged, not surfaced (best effort)", async () => {
      vi.mocked(del).mockRejectedValue(new Error("simulated Blob outage"));
      await expect(deleteAttachment(t.as("bob"), { attachmentId: t.fx.attachments.w1.id })).resolves.toMatchObject({
        id: t.fx.attachments.w1.id,
      });
      expect(await t.db.select().from(attachment).where(eq(attachment.id, t.fx.attachments.w1.id))).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        "[uploads] could not delete blobs",
        expect.objectContaining({ pathnames: [t.fx.attachments.w1.blobPathname] }),
      );
    });

    it("deleting twice: the second call is NotFound and calls del() no more", async () => {
      await deleteAttachment(t.as("bob"), { attachmentId: t.fx.attachments.w1.id });
      await expect(deleteAttachment(t.as("bob"), { attachmentId: t.fx.attachments.w1.id })).rejects.toBeInstanceOf(NotFoundError);
      expect(del).toHaveBeenCalledTimes(1);
    });
  });

  // ------------------------------------------------ AC-57 / AC-42 / DP13: page Trash

  describe("AC-57 / AC-42 / DP13 (supersede AC-28/DP4): Trash keeps attachment rows AND blobs, but blocks them", () => {
    it("bob trashes a page with two attachments: rows and blobs kept (no del), files 404 until restore", async () => {
      const second = w1Pathname("second-AbC123.pdf");
      vi.mocked(head).mockResolvedValue(simulatedHead(second));
      const registered = await registerUpload(t.as("bob"), { pageId: w1Page(), pathname: second, displayName: "second.pdf" });
      const ids = [t.fx.attachments.w1.id, registered.id];

      await trashPage(t.as("bob"), { pageId: w1Page(), workspaceId: w1() });

      expect(await t.db.select().from(attachment).where(eq(attachment.pageId, w1Page()))).toHaveLength(2);
      expect(del).not.toHaveBeenCalled();
      for (const attachmentId of ids) {
        for (const who of ["alice", "bob", "carol"] as const) {
          await expect(getAttachmentDownload(t.as(who), { attachmentId })).rejects.toBeInstanceOf(NotFoundError);
        }
        await expectDeniedUnchanged(() => deleteAttachment(t.as("bob"), { attachmentId }), NotFoundError);
      }
      await expectDeniedUnchanged(() => listAttachments(t.as("alice"), { pageId: w1Page() }), NotFoundError);

      await restorePage(t.as("alice"), { pageId: w1Page() });
      for (const attachmentId of ids) {
        await expect(getAttachmentDownload(t.as("carol"), { attachmentId })).resolves.toMatchObject({ id: attachmentId });
      }
      expect(del).not.toHaveBeenCalled();
    });

    it("a trashed page refuses new uploads: token request and registration → NotFound, the uploaded blob is deleted", async () => {
      await trashPage(t.as("bob"), { pageId: w1Page() });
      const pathname = w1Pathname("after-trash.pdf");
      await expectDeniedUnchanged(
        () =>
          authorizeUploadRequest(
            t.as("bob"),
            { pathname, clientPayload: JSON.stringify({ pageId: w1Page(), size: 10, contentType: "application/pdf" }) },
            { maxBytes: DEFAULT_UPLOAD_MAX_BYTES, allowedTypes: DEFAULT_UPLOAD_ALLOWED_TYPES },
          ),
        NotFoundError,
      );
      await expectDeniedUnchanged(
        () => registerUpload(t.as("bob"), { pageId: w1Page(), pathname, displayName: "after-trash.pdf" }),
        NotFoundError,
      );
      expect(head).not.toHaveBeenCalled();
    });

    it("AC-56: the page trashed between authorization and insert → NotFound, the blob is deleted, no row", async () => {
      const pathname = w1Pathname("trashed-late.pdf");
      vi.mocked(head).mockImplementation(async () => {
        await trashPage(t.as("alice"), { pageId: w1Page() });
        return simulatedHead(pathname);
      });
      await expect(
        registerUpload(t.as("bob"), { pageId: w1Page(), pathname, displayName: "trashed-late.pdf" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(del).toHaveBeenCalledWith([pathname], { token: SIMULATED_BLOB_TOKEN });
      expect(await t.db.select().from(attachment).where(eq(attachment.blobPathname, pathname))).toEqual([]);
    });

    it("a denied trash (carol, Viewer) touches neither rows nor blobs", async () => {
      await expectDeniedUnchanged(() => trashPage(t.as("carol"), { pageId: w1Page() }), ForbiddenError);
      expect(del).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------ server-action handlers

  describe("attachment server-action handlers (forged input, typed results)", () => {
    const wrap = (who: FixtureUserKey | null) =>
      createActionWrapper(async () => {
        if (!who) throw new UnauthenticatedError();
        return { userId: t.fx.users[who].id };
      });

    const form = (fields: Record<string, string>) => {
      const data = new FormData();
      for (const [key, value] of Object.entries(fields)) data.set(key, value);
      return data;
    };

    it("registerUpload: success returns only id/displayName and revalidates the server-resolved page", async () => {
      const pathname = w1Pathname("handler-AbC123.pdf");
      vi.mocked(head).mockResolvedValue(simulatedHead(pathname));
      const result = await wrap("bob")(registerUploadHandler)({
        pageId: w1Page(),
        pathname,
        displayName: "handler.pdf",
        workspaceId: w2(),
        createdBy: t.fx.users.dave.id,
        kind: "link",
      });
      expect(result).toEqual({ ok: true, data: { id: expect.any(String), displayName: "handler.pdf" } });
      expectNoRawBlobData(JSON.stringify(result));
      expect(revalidatePath).toHaveBeenCalledWith(`/w/${w1()}/p/${w1Page()}`);
      const [row] = await t.db.select().from(attachment).where(eq(attachment.blobPathname, pathname));
      expect(row).toMatchObject({ workspaceId: w1(), createdBy: t.fx.users.bob.id, kind: "upload" });
    });

    it.each([
      ["carol (Viewer)", "carol", "FORBIDDEN"],
      ["outsider", "outsider", "NOT_FOUND"],
    ] as const)("registerUpload as %s → %s, no rows, no Blob call", async (_label, who, code) => {
      const before = await snapshotAppTables(t.db);
      const result = await wrap(who)(registerUploadHandler)({ pageId: w1Page(), pathname: w1Pathname(), displayName: "x.pdf" });
      expect(result).toEqual({ ok: false, error: { code, message: expect.any(String) } });
      expect(await snapshotAppTables(t.db)).toEqual(before);
      expect(head).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("registerUpload without a session → UNAUTHENTICATED, handler never runs", async () => {
      const before = await snapshotAppTables(t.db);
      const result = await wrap(null)(registerUploadHandler)({ pageId: w1Page(), pathname: w1Pathname(), displayName: "x.pdf" });
      expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
      expect(await snapshotAppTables(t.db)).toEqual(before);
      expect(head).not.toHaveBeenCalled();
    });

    it.each([["a string", "pageId=x"], ["null", null], ["an array", [{ pageId: "x" }]]])(
      "registerUpload with %s as input → VALIDATION",
      async (_label, input) => {
        const result = await wrap("bob")(registerUploadHandler)(input);
        expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
      },
    );

    it("deleteAttachment: Viewer → FORBIDDEN, non-member → NOT_FOUND; Editor → ok and revalidates the page", async () => {
      const id = t.fx.attachments.w1.id;
      expect(await wrap("carol")(deleteAttachmentHandler)(null, form({ attachmentId: id }))).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(await wrap("dave")(deleteAttachmentHandler)(null, form({ attachmentId: id }))).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      expect(del).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();

      expect(await wrap("bob")(deleteAttachmentHandler)(null, form({ attachmentId: id, workspaceId: w2() }))).toEqual({
        ok: true,
        data: { id },
      });
      expect(revalidatePath).toHaveBeenCalledWith(`/w/${w1()}/p/${w1Page()}`);
      expect(del).toHaveBeenCalledWith([t.fx.attachments.w1.blobPathname], { token: SIMULATED_BLOB_TOKEN });
    });
  });
});
