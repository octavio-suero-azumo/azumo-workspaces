import { del } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Page deletion also deletes its attachments' blobs (DP4). The Blob server SDK
// is mocked: blob deletion is SIMULATED (manual TC-43 with a real store).
vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/blob")>();
  return { ...actual, head: vi.fn(), get: vi.fn(), del: vi.fn() };
});

import { CONTENT_INVALID_MESSAGE, CONTENT_NOT_A_DOCUMENT_MESSAGE } from "@/server/data/page-content";
import {
  createPage,
  deletePage,
  getPage,
  listPages,
  NOTHING_TO_UPDATE_MESSAGE,
  TITLE_REQUIRED_MESSAGE,
  TITLE_TOO_LONG_MESSAGE,
  updatePage,
} from "@/server/data/pages";
import { attachment, page } from "@/server/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { SIMULATED_BLOB_TOKEN } from "../support/blob-sim";
import { snapshotAppTables, type FixtureUserKey } from "../support/fixtures";
import { useFixtureDb } from "../support/fixture-db";
import { asEditorJson, formattedDoc, XSS_PAYLOADS, xssDoc } from "../support/page-docs";

// Increment D: T-10 (create/list/view), T-11 (edit + formatted content),
// T-12 (delete). R4.1, PR1, PR2, DP4, DP5.
// TC-24 (AC-19), TC-25 (AC-20), TC-26 (AC-27), TC-27 (AC-29, data level),
// TC-28 (AC-30, data level), TC-29 (AC-28), AC-15 page cells, AC-38.
// Direct server calls (no UI), as the test plan requires for authorization.

type ErrorClass = typeof ForbiddenError | typeof NotFoundError | typeof ValidationError;

describe("pages (T-10..T-12)", () => {
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
    vi.mocked(del).mockReset().mockResolvedValue(undefined);
  });

  const w1 = () => t.fx.workspaces.w1.id;
  const w2 = () => t.fx.workspaces.w2.id;
  const w1Page = () => t.fx.pages.w1[0];
  const w2Page = () => t.fx.pages.w2[0];

  const readRow = async (id: string) => (await t.db.select().from(page).where(eq(page.id, id)))[0];

  /** Denied: the right error class, no data from the page's workspace, and no DB change. */
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
    for (const p of [...t.fx.pages.w1, ...t.fx.pages.w2, ...t.fx.pages.w3]) {
      expect(text).not.toContain(p.title);
    }
    expect(await snapshotAppTables(t.db)).toEqual(before);
  }

  describe("AC-19 / TC-24: create", () => {
    it("bob (Editor) creates a page in W1: trimmed title, author recorded, listed in W1 and in no other workspace", async () => {
      const created = await createPage(t.as("bob"), { workspaceId: w1(), title: "  Bob's plan  " });
      expect(created).toMatchObject({ workspaceId: w1(), title: "Bob's plan" });

      const row = await readRow(created.id);
      expect(row).toMatchObject({
        workspaceId: w1(),
        title: "Bob's plan",
        content: null,
        createdBy: t.fx.users.bob.id,
        updatedBy: t.fx.users.bob.id,
      });

      for (const who of ["alice", "bob", "carol"] as const) {
        expect((await listPages(t.as(who), w1())).map((p) => p.id)).toContain(created.id);
      }
      expect((await listPages(t.as("alice"), w2())).map((p) => p.id)).not.toContain(created.id);
      expect((await listPages(t.as("dave"), w2())).map((p) => p.id)).not.toContain(created.id);
      expect((await listPages(t.as("erin"), t.fx.workspaces.w3.id)).map((p) => p.id)).not.toContain(created.id);
    });

    it("alice (Owner) can create a page in W1", async () => {
      await expect(createPage(t.as("alice"), { workspaceId: w1(), title: "Owner page" })).resolves.toMatchObject({
        workspaceId: w1(),
      });
    });

    it("carol (Viewer) is Forbidden (403) and nothing is written", async () => {
      await expectDeniedUnchanged(() => createPage(t.as("carol"), { workspaceId: w1(), title: "Nope" }), ForbiddenError);
    });

    it("alice is Forbidden in W2, where she is a Viewer (role never carries over, AC-37)", async () => {
      await expectDeniedUnchanged(() => createPage(t.as("alice"), { workspaceId: w2(), title: "Nope" }), ForbiddenError);
    });

    it.each(["outsider", "dave", "erin"] as const)("%s (non-member of W1) gets NotFound (404) and nothing is written", async (who) => {
      await expectDeniedUnchanged(() => createPage(t.as(who), { workspaceId: w1(), title: "Nope" }), NotFoundError);
    });

    it("a non-member gets NotFound even with an invalid title (authorization first)", async () => {
      await expectDeniedUnchanged(() => createPage(t.as("outsider"), { workspaceId: w1(), title: "" }), NotFoundError);
    });

    it("forged extra fields (id, author, workspace_id) are ignored", async () => {
      const forgedId = "11111111-1111-4111-8111-111111111111";
      const created = await createPage(t.as("bob"), {
        workspaceId: w1(),
        title: "Forged",
        id: forgedId,
        createdBy: t.fx.users.alice.id,
        updatedBy: t.fx.users.alice.id,
        workspace_id: w2(),
      });
      expect(created.id).not.toBe(forgedId);
      expect(await readRow(created.id)).toMatchObject({
        workspaceId: w1(),
        createdBy: t.fx.users.bob.id,
        updatedBy: t.fx.users.bob.id,
      });
    });

    it.each([
      ["1 character", "a", "a"],
      ["200 characters", "t".repeat(200), "t".repeat(200)],
      ["200 characters after trimming", `  ${"t".repeat(200)}  `, "t".repeat(200)],
      ["200 non-BMP characters (code points)", "😀".repeat(200), "😀".repeat(200)],
    ])("accepts a title of %s", async (_label, input, stored) => {
      const created = await createPage(t.as("bob"), { workspaceId: w1(), title: input });
      expect((await readRow(created.id)).title).toBe(stored);
    });

    it.each([
      ["empty", "", TITLE_REQUIRED_MESSAGE],
      ["whitespace only", " \t\n ", TITLE_REQUIRED_MESSAGE],
      ["201 characters", "x".repeat(201), TITLE_TOO_LONG_MESSAGE],
      ["201 non-BMP characters", "😀".repeat(201), TITLE_TOO_LONG_MESSAGE],
      ["not a string", 42, TITLE_REQUIRED_MESSAGE],
      ["missing", undefined, TITLE_REQUIRED_MESSAGE],
    ])("rejects a title that is %s and writes nothing", async (_label, title, message) => {
      const before = await snapshotAppTables(t.db);
      const error = await createPage(t.as("bob"), { workspaceId: w1(), title }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toBe(message);
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });

    it("rejects a non-object input", async () => {
      await expect(createPage(t.as("bob"), null)).rejects.toBeInstanceOf(ValidationError);
      await expect(createPage(t.as("bob"), "W1")).rejects.toBeInstanceOf(ValidationError);
    });

    it("stores validated initial content, and rejects invalid initial content without writing", async () => {
      const content = formattedDoc();
      const created = await createPage(t.as("bob"), { workspaceId: w1(), title: "With content", content });
      expect((await getPage(t.as("carol"), { pageId: created.id })).content).toEqual(content);

      await expectDeniedUnchanged(
        () => createPage(t.as("bob"), { workspaceId: w1(), title: "Bad", content: "<p>html</p>" }),
        ValidationError,
      );
    });
  });

  describe("AC-20 / TC-25: every member can open a page", () => {
    it.each([
      ["alice", "owner"],
      ["bob", "editor"],
      ["carol", "viewer"],
    ] as const)("%s opens a W1 page and gets its title, content and their role", async (who, role) => {
      const content = formattedDoc();
      await t.db.update(page).set({ content }).where(eq(page.id, w1Page().id));

      const opened = await getPage(t.as(who), { pageId: w1Page().id, workspaceId: w1() });
      expect(opened).toMatchObject({ id: w1Page().id, workspaceId: w1(), title: w1Page().title, role });
      expect(opened.content).toEqual(content);
    });

    it("a page created without content opens with content null", async () => {
      const created = await createPage(t.as("bob"), { workspaceId: w1(), title: "Empty" });
      expect((await getPage(t.as("carol"), { pageId: created.id })).content).toBeNull();
    });

    it.each(["outsider", "dave", "erin"] as const)("%s (non-member) gets NotFound", async (who) => {
      await expectDeniedUnchanged(() => getPage(t.as(who), { pageId: w1Page().id }), NotFoundError);
    });

    it.each([
      ["an unknown id", "3f2b7c1e-9a4d-4e2f-8b6a-1c2d3e4f5a6b"],
      ["a malformed id", "not-a-uuid"],
      ["an empty id", ""],
    ])("%s is NotFound", async (_label, pageId) => {
      await expect(getPage(t.as("alice"), { pageId })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("AC-27 / TC-26: edit", () => {
    it("bob (Editor) edits title and content; a fresh read returns the new values", async () => {
      const before = await readRow(w1Page().id);
      const content = formattedDoc();
      const updated = await updatePage(t.as("bob"), {
        pageId: w1Page().id,
        workspaceId: w1(),
        title: "  Renamed roadmap ",
        content,
      });
      expect(updated).toMatchObject({ id: w1Page().id, workspaceId: w1(), title: "Renamed roadmap" });

      const reloaded = await getPage(t.as("carol"), { pageId: w1Page().id, workspaceId: w1() });
      expect(reloaded.title).toBe("Renamed roadmap");
      expect(reloaded.content).toEqual(content);

      const row = await readRow(w1Page().id);
      expect(row.updatedBy).toBe(t.fx.users.bob.id);
      expect(row.createdBy).toBe(before.createdBy);
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    });

    it("title only, then content only; each leaves the other field unchanged", async () => {
      const content = formattedDoc();
      await updatePage(t.as("alice"), { pageId: w1Page().id, content });
      await updatePage(t.as("alice"), { pageId: w1Page().id, title: "Only the title" });
      expect(await readRow(w1Page().id)).toMatchObject({ title: "Only the title", content });

      const other = asEditorJson({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "v2" }] }] });
      await updatePage(t.as("alice"), { pageId: w1Page().id, content: other });
      expect(await readRow(w1Page().id)).toMatchObject({ title: "Only the title", content: other });
    });

    it("carol (Viewer) is Forbidden (403) and nothing changes", async () => {
      await expectDeniedUnchanged(
        () => updatePage(t.as("carol"), { pageId: w1Page().id, title: "Hacked", content: formattedDoc() }),
        ForbiddenError,
      );
    });

    it.each(["outsider", "dave", "erin"] as const)("%s (non-member) gets NotFound and nothing changes", async (who) => {
      await expectDeniedUnchanged(() => updatePage(t.as(who), { pageId: w1Page().id, title: "Hacked" }), NotFoundError);
    });

    it("an update with neither title nor content is a validation error", async () => {
      const error = await updatePage(t.as("bob"), { pageId: w1Page().id }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toBe(NOTHING_TO_UPDATE_MESSAGE);
    });

    it.each([
      ["an empty title", { title: "   " }],
      ["a title over 200 characters", { title: "x".repeat(201) }],
      ["content as an HTML string", { content: "<h1>x</h1>" }],
      ["null content", { content: null }],
      ["content with an unknown node", { content: { type: "doc", content: [{ type: "iframe" }] } }],
      ["a valid title with invalid content (all or nothing)", { title: "Fine", content: { type: "doc", content: ["<b>x</b>"] } }],
    ])("%s is rejected and nothing changes", async (_label, fields) => {
      await expectDeniedUnchanged(() => updatePage(t.as("bob"), { pageId: w1Page().id, ...fields }), ValidationError);
    });
  });

  describe("AC-28 / TC-29: delete (hard delete, DP4; Editors may delete, DP5)", () => {
    it("bob (Editor) deletes a W1 page: every later read is NotFound and it leaves the list", async () => {
      const target = w1Page();
      await expect(deletePage(t.as("bob"), { pageId: target.id, workspaceId: w1() })).resolves.toEqual({
        id: target.id,
        workspaceId: w1(),
      });

      expect(await readRow(target.id)).toBeUndefined();
      for (const who of ["alice", "bob", "carol"] as const) {
        await expect(getPage(t.as(who), { pageId: target.id })).rejects.toBeInstanceOf(NotFoundError);
      }
      expect((await listPages(t.as("alice"), w1())).map((p) => p.id)).not.toContain(target.id);
      // The other W1 page is untouched.
      expect(await readRow(t.fx.pages.w1[1].id)).toBeDefined();

      // DP4: its attachment rows are gone and their blobs were deleted (SIMULATED del()).
      expect(await t.db.select().from(attachment).where(eq(attachment.pageId, target.id))).toEqual([]);
      expect(del).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledWith([t.fx.attachments.w1.blobPathname], { token: SIMULATED_BLOB_TOKEN });
      // Other workspaces' attachments are untouched.
      expect(await t.db.select().from(attachment)).toHaveLength(2);
    });

    it("alice (Owner) can delete", async () => {
      await deletePage(t.as("alice"), { pageId: w1Page().id });
      expect(await readRow(w1Page().id)).toBeUndefined();
      expect(del).toHaveBeenCalledWith([t.fx.attachments.w1.blobPathname], { token: SIMULATED_BLOB_TOKEN });
    });

    it("carol (Viewer) is Forbidden and nothing changes (no blob deleted)", async () => {
      await expectDeniedUnchanged(() => deletePage(t.as("carol"), { pageId: w1Page().id }), ForbiddenError);
      expect(del).not.toHaveBeenCalled();
    });

    it.each(["outsider", "dave", "erin"] as const)("%s (non-member) gets NotFound and nothing changes", async (who) => {
      await expectDeniedUnchanged(() => deletePage(t.as(who), { pageId: w1Page().id }), NotFoundError);
      expect(del).not.toHaveBeenCalled();
    });

    it("deleting the same page twice: the second call is NotFound", async () => {
      await deletePage(t.as("bob"), { pageId: w1Page().id });
      await expect(deletePage(t.as("bob"), { pageId: w1Page().id })).rejects.toBeInstanceOf(NotFoundError);
      expect(del).toHaveBeenCalledTimes(1);
    });
  });

  describe("AC-29 / TC-27 (data level): formatted content survives save and reload", () => {
    it("the editor's serialized document (H1–H3, bold, italic, both list types) deep-equals after reload", async () => {
      const serializedBeforeSave = formattedDoc();
      const nodeTypes = JSON.stringify(serializedBeforeSave);
      for (const expected of ['"level":1', '"level":2', '"level":3', '"bold"', '"italic"', '"bulletList"', '"orderedList"']) {
        expect(nodeTypes).toContain(expected);
      }

      await updatePage(t.as("bob"), { pageId: w1Page().id, content: serializedBeforeSave });
      const reloaded = await getPage(t.as("bob"), { pageId: w1Page().id });

      expect(reloaded.content).toEqual(serializedBeforeSave);
      // What comes back is still a valid editor document (loads into the schema unchanged).
      expect(asEditorJson(reloaded.content as never)).toEqual(serializedBeforeSave);
    });
  });

  describe("AC-30 / TC-28 (data level): script and onerror payloads", () => {
    it("typed as text, they are stored and returned verbatim as text (content and title)", async () => {
      const content = xssDoc();
      const created = await createPage(t.as("bob"), { workspaceId: w1(), title: XSS_PAYLOADS[1], content });
      const reloaded = await getPage(t.as("carol"), { pageId: created.id });

      expect(reloaded.title).toBe(XSS_PAYLOADS[1]);
      expect(reloaded.content).toEqual(content);
      const texts: string[] = [];
      const collect = (node: { text?: string; content?: unknown[] }) => {
        if (typeof node.text === "string") texts.push(node.text);
        (node.content ?? []).forEach((child) => collect(child as never));
      };
      collect(reloaded.content as never);
      for (const payload of XSS_PAYLOADS) expect(texts).toContain(payload);
    });

    it.each([
      ["an html node", { type: "doc", content: [{ type: "html", content: [{ type: "text", text: "<script>alert(1)</script>" }] }] }, CONTENT_INVALID_MESSAGE],
      ["an image with onerror", { type: "doc", content: [{ type: "image", attrs: { src: "x", onerror: "alert(1)" } }] }, CONTENT_INVALID_MESSAGE],
      ["a raw HTML string as a node", { type: "doc", content: ['<img src=x onerror="alert(1)">'] }, CONTENT_INVALID_MESSAGE],
      ["an onerror attribute on a paragraph", { type: "doc", content: [{ type: "paragraph", attrs: { onerror: "alert(1)" } }] }, CONTENT_INVALID_MESSAGE],
      ["the whole document as HTML", "<script>alert(1)</script>", CONTENT_NOT_A_DOCUMENT_MESSAGE],
    ])("%s is rejected by validation and 0 rows change", async (_label, content, message) => {
      const before = await snapshotAppTables(t.db);
      const error = await updatePage(t.as("bob"), { pageId: w1Page().id, content }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toBe(message);
      expect(await snapshotAppTables(t.db)).toEqual(before);
    });
  });

  describe("AC-15 (page cells, data functions): Owner and Editor may write, Viewer may not", () => {
    const cells: Array<[FixtureUserKey, boolean]> = [
      ["alice", true],
      ["bob", true],
      ["carol", false],
    ];

    it.each(cells)("%s → create/edit/delete allowed=%s", async (who, allowed) => {
      const ctx = t.as(who);
      const calls = [
        () => createPage(ctx, { workspaceId: w1(), title: `by ${who}` }),
        () => updatePage(ctx, { pageId: w1Page().id, title: `edited by ${who}` }),
        () => deletePage(ctx, { pageId: t.fx.pages.w1[1].id }),
      ];
      for (const call of calls) {
        if (allowed) await expect(call()).resolves.toBeDefined();
        else await expectDeniedUnchanged(call, ForbiddenError);
      }
    });
  });

  describe("AC-38: a W2 pageId used with a W1 route/context", () => {
    it("get: alice (Viewer in W2) may read the page only under its own workspace's route", async () => {
      await expect(getPage(t.as("alice"), { pageId: w2Page().id, workspaceId: w2() })).resolves.toMatchObject({
        workspaceId: w2(),
        role: "viewer",
      });
      await expectDeniedUnchanged(() => getPage(t.as("alice"), { pageId: w2Page().id, workspaceId: w1() }), NotFoundError);
    });

    it("update/delete by alice (W1 Owner, W2 Viewer) with W1 context → Forbidden by her W2 role, 0 rows", async () => {
      const substituted = { pageId: w2Page().id, workspaceId: w1() };
      await expectDeniedUnchanged(() => updatePage(t.as("alice"), { ...substituted, title: "x" }), ForbiddenError);
      await expectDeniedUnchanged(() => deletePage(t.as("alice"), substituted), ForbiddenError);
    });

    it("update/delete by dave (W2 Owner) under a W1 route → NotFound, 0 rows", async () => {
      const substituted = { pageId: w2Page().id, workspaceId: w1() };
      await expectDeniedUnchanged(() => updatePage(t.as("dave"), { ...substituted, title: "x" }), NotFoundError);
      await expectDeniedUnchanged(() => deletePage(t.as("dave"), substituted), NotFoundError);
      await expectDeniedUnchanged(() => getPage(t.as("dave"), substituted), NotFoundError);
    });

    it("bob (member of W1 only) with a W2 pageId and W1 context → NotFound, 0 rows", async () => {
      const substituted = { pageId: w2Page().id, workspaceId: w1() };
      await expectDeniedUnchanged(() => getPage(t.as("bob"), substituted), NotFoundError);
      await expectDeniedUnchanged(() => updatePage(t.as("bob"), { ...substituted, title: "x" }), NotFoundError);
      await expectDeniedUnchanged(() => deletePage(t.as("bob"), substituted), NotFoundError);
    });

    it("a non-string or unknown route workspace is NotFound, never a DB error", async () => {
      for (const workspaceId of [42, "not-a-uuid", "", w2()]) {
        await expectDeniedUnchanged(
          () => updatePage(t.as("bob"), { pageId: w1Page().id, workspaceId, title: "x" }),
          NotFoundError,
        );
      }
    });

    it("create: bob targeting W2 → NotFound; alice targeting W2 → Forbidden; 0 rows", async () => {
      await expectDeniedUnchanged(() => createPage(t.as("bob"), { workspaceId: w2(), title: "x" }), NotFoundError);
      await expectDeniedUnchanged(() => createPage(t.as("alice"), { workspaceId: w2(), title: "x" }), ForbiddenError);
    });
  });
});
