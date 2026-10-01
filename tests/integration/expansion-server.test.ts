import { copy, del, head } from "@vercel/blob";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The Blob server SDK is mocked (SIMULATED): copy/head/del are recorded so the
// tests can prove WHICH blob operations happen, in which order, and that a
// failed operation cleans up only its own copies. Real Blob behaviour is a
// manual check (TC-43 / TC-108).
vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/blob")>();
  return { ...actual, head: vi.fn(), get: vi.fn(), del: vi.fn(), copy: vi.fn() };
});

import { uploadPathPrefix } from "@/lib/attachment-rules";
import { DEFAULT_PAGE_ICON } from "@/lib/icons";
import { getAttachmentDownload, listAttachments } from "@/server/data/attachments";
import {
  createEvent,
  deleteEvent,
  EVENT_DATES_MESSAGE,
  EVENT_END_BEFORE_START_MESSAGE,
  EVENT_TIME_ZONE_MESSAGE,
  getEvent,
  INVALID_EVENT_PAGE_MESSAGE,
  listEventsInRange,
  listUpcomingEvents,
  updateEvent,
} from "@/server/data/events";
import { listRecentPages, listSidebarPages } from "@/server/data/home";
import { removeMember } from "@/server/data/members";
import { ATTACHMENTS_CHANGED_MESSAGE, COPY_FAILED_MESSAGE, duplicatePage, movePage } from "@/server/data/page-transfer";
import {
  getPage,
  INVALID_ICON_MESSAGE,
  INVALID_PRESENTATION_MESSAGE,
  listPages,
  listTrash,
  restorePage,
  trashPage,
  updatePage,
  updatePageIcon,
  updatePagePresentation,
} from "@/server/data/pages";
import { createWorkspace, listMyWorkspaces, updateWorkspace } from "@/server/data/workspaces";
import { attachment, calendarEvent, membership, page } from "@/server/db/schema";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@/server/errors";
import { simulatedHead, SIMULATED_BLOB_TOKEN } from "../support/blob-sim";
import { snapshotAppTables } from "../support/fixtures";
import { useFixtureDb } from "../support/fixture-db";

// Scope expansion E2–E10 (PRD §12), server level, direct calls (no UI).
// Auth: test fixtures (simulated sessions are not even needed: data functions
// take the requester context). Data: isolated in-memory PGlite per test.

type ErrorClass =
  | typeof ForbiddenError
  | typeof NotFoundError
  | typeof ValidationError
  | typeof ConflictError
  | typeof ServiceUnavailableError;

describe("scope expansion (server)", () => {
  const t = useFixtureDb();

  /** Simulated private store: pathname → size. `copy` appends a random-like suffix like Blob does. */
  let store: Map<string, number>;
  let copyCounter = 0;

  beforeAll(() => {
    vi.stubEnv("ALLOWED_GOOGLE_HD", "allowed.test");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", SIMULATED_BLOB_TOKEN);
    vi.stubEnv("UPLOAD_MAX_BYTES", "");
    vi.stubEnv("UPLOAD_ALLOWED_TYPES", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("VERCEL_ENV", "");
  });
  afterAll(() => vi.unstubAllEnvs());

  beforeEach(() => {
    store = new Map(Object.values(t.fx.attachments).map((a) => [a.blobPathname, a.sizeBytes]));
    vi.mocked(copy)
      .mockReset()
      .mockImplementation(async (from: string, to: string) => {
        const size = store.get(from);
        if (size === undefined) throw new Error("source blob not found");
        copyCounter += 1;
        const pathname = to.replace(/(\.[A-Za-z0-9]+)?$/, (ext) => `-Sfx${copyCounter}${ext}`);
        store.set(pathname, size);
        return { pathname } as Awaited<ReturnType<typeof copy>>;
      });
    vi.mocked(head)
      .mockReset()
      .mockImplementation(async (pathname: string) => {
        const size = store.get(pathname);
        if (size === undefined) throw new Error("not found");
        return simulatedHead(pathname, { size });
      });
    vi.mocked(del)
      .mockReset()
      .mockImplementation(async (pathnames: string | string[]) => {
        for (const p of Array.isArray(pathnames) ? pathnames : [pathnames]) store.delete(p);
      });
  });

  const w1 = () => t.fx.workspaces.w1.id;
  const w2 = () => t.fx.workspaces.w2.id;
  const w1Page = () => t.fx.pages.w1[0].id; // has the W1 attachment
  const w1Other = () => t.fx.pages.w1[1].id; // no attachment
  const readPage = async (id: string) => (await t.db.select().from(page).where(eq(page.id, id)))[0];
  const attachmentsOf = (pageId: string) => t.db.select().from(attachment).where(eq(attachment.pageId, pageId));

  async function expectDeniedUnchanged(call: () => Promise<unknown>, errorClass: ErrorClass) {
    const before = await snapshotAppTables(t.db);
    const error = await call().then(
      () => {
        throw new Error("expected the call to be denied, but it succeeded");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(errorClass);
    expect(await snapshotAppTables(t.db)).toEqual(before);
    return error as Error;
  }

  // ---------------------------------------------------------------- E2 icons

  describe("AC-44 icons (E2): curated allowlist, set and reset, permissions", () => {
    it("bob (Editor) sets and resets a page icon", async () => {
      await expect(updatePageIcon(t.as("bob"), { pageId: w1Page(), icon: "🚀" })).resolves.toMatchObject({ icon: "🚀" });
      expect((await readPage(w1Page())).icon).toBe("🚀");
      await expect(updatePageIcon(t.as("bob"), { pageId: w1Page(), icon: null })).resolves.toMatchObject({ icon: null });
      expect((await readPage(w1Page())).icon).toBeNull();
      expect(DEFAULT_PAGE_ICON).toBe("📄");
    });

    it.each([
      ["HTML", "<b>x</b>"],
      ["SVG", "<svg onload=alert(1)>"],
      ["a URL", "https://evil.example/x.png"],
      ["a javascript: URL", "javascript:alert(1)"],
      ["two emojis", "🚀🚀"],
      ["an unlisted emoji", "🤖"],
      ["plain text", "x"],
      ["a number", 42],
    ])("rejects %s with 400 and changes nothing", async (_label, icon) => {
      const error = await expectDeniedUnchanged(() => updatePageIcon(t.as("bob"), { pageId: w1Page(), icon }), ValidationError);
      expect(error.message).toBe(INVALID_ICON_MESSAGE);
      expect(error.message).not.toContain(String(icon));
    });

    it("carol (Viewer) cannot change a page icon (403); non-members get 404", async () => {
      await expectDeniedUnchanged(() => updatePageIcon(t.as("carol"), { pageId: w1Page(), icon: "🚀" }), ForbiddenError);
      await expectDeniedUnchanged(() => updatePageIcon(t.as("dave"), { pageId: w1Page(), icon: "🚀" }), NotFoundError);
    });

    it("workspace icon and name: Owner only; Editor 403; non-member 404; names trimmed", async () => {
      await expect(updateWorkspace(t.as("alice"), { workspaceId: w1(), icon: "📚", name: "  Renamed  " })).resolves.toMatchObject({
        id: w1(),
        name: "Renamed",
        icon: "📚",
      });
      const mine = await listMyWorkspaces(t.as("alice"));
      expect(mine.find((w) => w.id === w1())).toMatchObject({ name: "Renamed", icon: "📚" });
      await expectDeniedUnchanged(() => updateWorkspace(t.as("bob"), { workspaceId: w1(), icon: "🚀" }), ForbiddenError);
      await expectDeniedUnchanged(() => updateWorkspace(t.as("carol"), { workspaceId: w1(), name: "x" }), ForbiddenError);
      await expectDeniedUnchanged(() => updateWorkspace(t.as("outsider"), { workspaceId: w1(), name: "x" }), NotFoundError);
      await expectDeniedUnchanged(() => updateWorkspace(t.as("alice"), { workspaceId: w1(), name: "   " }), ValidationError);
      await expectDeniedUnchanged(() => updateWorkspace(t.as("alice"), { workspaceId: w1(), icon: "<i>" }), ValidationError);
      await expect(updateWorkspace(t.as("alice"), { workspaceId: w1(), icon: null })).resolves.toMatchObject({ icon: null });
    });
  });

  // -------------------------------------------------------- E5 presentation

  describe("AC-50 presentation (E5): shared, persisted, enum/booleans only", () => {
    it("bob sets font, small text and full width; everyone reads the same values", async () => {
      await updatePagePresentation(t.as("bob"), { pageId: w1Page(), font: "serif", smallText: true, fullWidth: true });
      for (const who of ["alice", "bob", "carol"] as const) {
        await expect(getPage(t.as(who), { pageId: w1Page() })).resolves.toMatchObject({
          font: "serif",
          smallText: true,
          fullWidth: true,
        });
      }
      await updatePagePresentation(t.as("alice"), { pageId: w1Page(), font: "mono" });
      expect(await readPage(w1Page())).toMatchObject({ font: "mono", smallText: true, fullWidth: true });
    });

    it.each([
      ["an unknown font", { font: "comic-sans" }],
      ["a CSS string", { font: "font-family: x; background: url(evil)" }],
      ["a non-boolean", { smallText: "yes" }],
      ["an extra key", { css: "body{display:none}" }],
      ["nothing to change", {}],
    ])("rejects %s with 400", async (_label, fields) => {
      const error = await expectDeniedUnchanged(
        () => updatePagePresentation(t.as("bob"), { pageId: w1Page(), ...fields }),
        ValidationError,
      );
      if (Object.keys(fields).length > 0) expect(error.message).toBe(INVALID_PRESENTATION_MESSAGE);
    });

    it("carol (Viewer) cannot change it (403); dave (non-member) gets 404", async () => {
      await expectDeniedUnchanged(() => updatePagePresentation(t.as("carol"), { pageId: w1Page(), fullWidth: true }), ForbiddenError);
      await expectDeniedUnchanged(() => updatePagePresentation(t.as("dave"), { pageId: w1Page(), fullWidth: true }), NotFoundError);
    });
  });

  // ------------------------------------------------------- E10 trash rule

  describe("AC-42 trash rule: a trashed page is unreachable except for restore", () => {
    it("every normal path is 404 or omits it; restore brings everything back", async () => {
      const [event] = await t.db
        .insert(calendarEvent)
        .values({
          workspaceId: w1(),
          title: "Linked",
          allDay: true,
          startDate: "2026-11-01",
          endDate: "2026-11-01",
          pageId: w1Page(),
          createdBy: t.fx.users.alice.id,
          updatedBy: t.fx.users.alice.id,
        })
        .returning({ id: calendarEvent.id });

      await trashPage(t.as("bob"), { pageId: w1Page() });
      const bob = t.as("bob");
      const alice = t.as("alice");

      await expect(getPage(bob, { pageId: w1Page() })).rejects.toBeInstanceOf(NotFoundError);
      expect((await listPages(alice, w1())).map((p) => p.id)).not.toContain(w1Page());
      expect((await listSidebarPages(alice))[w1()]?.map((p) => p.id) ?? []).not.toContain(w1Page());
      expect((await listRecentPages(alice)).map((p) => p.id)).not.toContain(w1Page());
      await expect(listAttachments(bob, { pageId: w1Page() })).rejects.toBeInstanceOf(NotFoundError);
      await expect(getAttachmentDownload(bob, { attachmentId: t.fx.attachments.w1.id })).rejects.toBeInstanceOf(NotFoundError);
      await expectDeniedUnchanged(() => updatePageIcon(bob, { pageId: w1Page(), icon: "🚀" }), NotFoundError);
      await expectDeniedUnchanged(() => updatePagePresentation(bob, { pageId: w1Page(), fullWidth: true }), NotFoundError);
      await expectDeniedUnchanged(() => duplicatePage(bob, { pageId: w1Page() }), NotFoundError);
      await expectDeniedUnchanged(() => movePage(alice, { pageId: w1Page(), destinationWorkspaceId: w2() }), NotFoundError);
      // DP14: the event keeps the link in the DB but never exposes the trashed page.
      expect((await getEvent(bob, { eventId: event.id })).page).toBeNull();
      const range = await listEventsInRange(bob, { workspaceId: w1(), from: "2026-11-01", to: "2026-11-30" });
      expect(range.find((e) => e.id === event.id)?.page).toBeNull();
      expect(JSON.stringify(range)).not.toContain(t.fx.pages.w1[0].title);
      // A trashed page cannot be newly linked.
      await expectDeniedUnchanged(
        () => createEvent(bob, { workspaceId: w1(), title: "x", allDay: true, startDate: "2026-11-02", endDate: "2026-11-02", pageId: w1Page() }),
        ValidationError,
      );
      expect(del).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();

      await restorePage(alice, { pageId: w1Page() });
      await expect(getPage(bob, { pageId: w1Page() })).resolves.toMatchObject({ id: w1Page() });
      expect((await getEvent(bob, { eventId: event.id })).page).toMatchObject({ id: w1Page() });
      await expect(getAttachmentDownload(bob, { attachmentId: t.fx.attachments.w1.id })).resolves.toMatchObject({
        id: t.fx.attachments.w1.id,
      });
    });

    it("AC-57: restore checks the CURRENT role: demoted to Viewer → 403; removed → 404", async () => {
      await trashPage(t.as("bob"), { pageId: w1Page() });
      await t.db.update(membership).set({ role: "viewer" }).where(eq(membership.id, t.fx.memberships["bob:w1"]));
      await expectDeniedUnchanged(() => restorePage(t.as("bob"), { pageId: w1Page() }), ForbiddenError);
      await removeMember(t.as("alice"), { membershipId: t.fx.memberships["bob:w1"] });
      await expectDeniedUnchanged(() => restorePage(t.as("bob"), { pageId: w1Page() }), NotFoundError);
      expect(await listTrash(t.as("bob"))).toEqual([]);
    });
  });

  // ------------------------------------------------------------ E4 events

  describe("AC-46 / AC-47 / AC-48 calendar events (E4)", () => {
    const allDay = (fields: Record<string, unknown> = {}) => ({
      workspaceId: w1(),
      title: "Offsite",
      allDay: true,
      startDate: "2026-11-01",
      endDate: "2026-11-01",
      ...fields,
    });

    it("bob (Editor) creates an all-day event; every member sees the SAME date strings", async () => {
      const created = await createEvent(t.as("bob"), allDay({ description: "  Bring laptops  " }));
      expect(created).toMatchObject({
        title: "Offsite",
        description: "Bring laptops",
        allDay: true,
        startDate: "2026-11-01",
        endDate: "2026-11-01",
        startAt: null,
        endAt: null,
        timeZone: null,
        page: null,
      });
      for (const who of ["alice", "bob", "carol"] as const) {
        const list = await listEventsInRange(t.as(who), { workspaceId: w1(), from: "2026-11-01", to: "2026-11-30" });
        expect(list.map((e) => [e.id, e.startDate, e.endDate])).toEqual([[created.id, "2026-11-01", "2026-11-01"]]);
      }
    });

    it("a timed event keeps one instant and its author's time zone", async () => {
      const created = await createEvent(t.as("bob"), {
        workspaceId: w1(),
        title: "Standup",
        allDay: false,
        startAt: "2026-11-01T09:00:00.000-10:00",
        endAt: "2026-11-01T09:30:00.000-10:00",
        timeZone: "Pacific/Honolulu",
      });
      expect(created).toMatchObject({
        startAt: "2026-11-01T19:00:00.000Z",
        endAt: "2026-11-01T19:30:00.000Z",
        timeZone: "Pacific/Honolulu",
        startDate: null,
      });
    });

    const allDayFields = { title: "Offsite", allDay: true, startDate: "2026-11-01", endDate: "2026-11-01" };
    it.each([
      ["an empty title", { ...allDayFields, title: "   " }],
      ["an impossible date", { ...allDayFields, startDate: "2026-02-30", endDate: "2026-02-30" }],
      ["an end before the start (all-day)", { ...allDayFields, startDate: "2026-11-02", endDate: "2026-11-01" }],
      [
        "an end equal to the start (timed)",
        { workspaceId: "W1", title: "x", allDay: false, startAt: "2026-11-01T10:00:00Z", endAt: "2026-11-01T10:00:00Z", timeZone: "UTC" },
      ],
      [
        "an unknown time zone",
        { workspaceId: "W1", title: "x", allDay: false, startAt: "2026-11-01T10:00:00Z", endAt: "2026-11-01T11:00:00Z", timeZone: "Mars/Phobos" },
      ],
      ["a non-ISO instant", { workspaceId: "W1", title: "x", allDay: false, startAt: "tomorrow", endAt: "later", timeZone: "UTC" }],
    ])("rejects %s with 400 and writes nothing", async (_label, fields) => {
      const input = { ...fields, workspaceId: w1() };
      const error = await expectDeniedUnchanged(() => createEvent(t.as("bob"), input), ValidationError);
      expect([
        "Event title is required.",
        EVENT_DATES_MESSAGE,
        EVENT_END_BEFORE_START_MESSAGE,
        EVENT_TIME_ZONE_MESSAGE,
      ]).toContain(error.message);
    });

    it("AC-48: a page of ANOTHER workspace (or a random id) is the same 400 — no hint it exists", async () => {
      const foreign = await expectDeniedUnchanged(
        () => createEvent(t.as("alice"), allDay({ pageId: t.fx.pages.w2[0].id })),
        ValidationError,
      );
      const random = await expectDeniedUnchanged(
        () => createEvent(t.as("alice"), allDay({ pageId: "00000000-0000-4000-8000-000000000000" })),
        ValidationError,
      );
      expect(foreign.message).toBe(INVALID_EVENT_PAGE_MESSAGE);
      expect(random.message).toBe(foreign.message);
    });

    it("role matrix: Viewer reads but cannot write (403); non-members get 404", async () => {
      const created = await createEvent(t.as("bob"), allDay());
      await expectDeniedUnchanged(() => createEvent(t.as("carol"), allDay()), ForbiddenError);
      await expectDeniedUnchanged(() => updateEvent(t.as("carol"), { eventId: created.id, ...allDay({ title: "x" }) }), ForbiddenError);
      await expectDeniedUnchanged(() => deleteEvent(t.as("carol"), { eventId: created.id }), ForbiddenError);
      for (const who of ["dave", "erin", "outsider"] as const) {
        await expectDeniedUnchanged(() => getEvent(t.as(who), { eventId: created.id }), NotFoundError);
        await expectDeniedUnchanged(() => updateEvent(t.as(who), { eventId: created.id, ...allDay({ title: "x" }) }), NotFoundError);
        await expectDeniedUnchanged(() => deleteEvent(t.as(who), { eventId: created.id }), NotFoundError);
        await expectDeniedUnchanged(
          () => listEventsInRange(t.as(who), { workspaceId: w1(), from: "2026-11-01", to: "2026-11-30" }),
          NotFoundError,
        );
      }
      await expect(updateEvent(t.as("alice"), { eventId: created.id, ...allDay({ title: "Renamed" }) })).resolves.toMatchObject({
        title: "Renamed",
      });
      await expect(deleteEvent(t.as("bob"), { eventId: created.id })).resolves.toMatchObject({ id: created.id });
      await expect(getEvent(t.as("alice"), { eventId: created.id })).rejects.toBeInstanceOf(NotFoundError);
    });

    it("Home upcoming events: only my workspaces (alice: W1 + W2, never W3)", async () => {
      await createEvent(t.as("bob"), allDay({ title: "W1 event", startDate: "2999-01-01", endDate: "2999-01-01" }));
      await createEvent(t.as("dave"), { ...allDay({ title: "W2 event", startDate: "2999-01-02", endDate: "2999-01-02" }), workspaceId: w2() });
      await createEvent(t.as("erin"), {
        ...allDay({ title: "W3 SECRET event", startDate: "2999-01-03", endDate: "2999-01-03" }),
        workspaceId: t.fx.workspaces.w3.id,
      });
      const upcoming = await listUpcomingEvents(t.as("alice"), { today: "2998-12-31" });
      expect(upcoming.map((e) => e.title)).toEqual(["W1 event", "W2 event"]);
      expect(JSON.stringify(upcoming)).not.toContain("SECRET");
    });
  });

  // -------------------------------------------------------- E8 duplicate

  describe("AC-52 duplicate (E8): independent page and blobs", () => {
    it("bob duplicates a page with an attachment: new id, same content/icon/presentation, independent blob", async () => {
      await updatePageIcon(t.as("bob"), { pageId: w1Page(), icon: "📌" });
      await updatePagePresentation(t.as("bob"), { pageId: w1Page(), font: "mono", fullWidth: true });
      const source = await readPage(w1Page());

      const created = await duplicatePage(t.as("bob"), { pageId: w1Page() });
      expect(created.workspaceId).toBe(w1());
      expect(created.id).not.toBe(w1Page());
      const copyRow = await readPage(created.id);
      expect(copyRow).toMatchObject({
        title: source.title,
        content: source.content,
        icon: "📌",
        font: "mono",
        fullWidth: true,
        smallText: false,
        createdBy: t.fx.users.bob.id,
        deletedAt: null,
      });

      const [copied] = await attachmentsOf(created.id);
      expect(copied.blobPathname.startsWith(uploadPathPrefix(w1(), created.id))).toBe(true);
      expect(copied.blobPathname).not.toBe(t.fx.attachments.w1.blobPathname);
      expect(copied).toMatchObject({ displayName: t.fx.attachments.w1.displayName, sizeBytes: t.fx.attachments.w1.sizeBytes });
      expect(copy).toHaveBeenCalledWith(
        t.fx.attachments.w1.blobPathname,
        expect.stringMatching(new RegExp(`^${uploadPathPrefix(w1(), created.id)}`)),
        expect.objectContaining({ access: "private", addRandomSuffix: true, allowOverwrite: false, token: SIMULATED_BLOB_TOKEN }),
      );
      // The original is untouched and nothing was deleted.
      expect(await attachmentsOf(w1Page())).toHaveLength(1);
      expect(del).not.toHaveBeenCalled();
      // No events or members are copied.
      expect(await t.db.select().from(calendarEvent)).toEqual([]);
    });

    it("a copy failure creates nothing and cleans only this attempt's copies", async () => {
      vi.mocked(head).mockImplementation(async (pathname: string) => simulatedHead(pathname, { size: 1 })); // size mismatch
      const before = await snapshotAppTables(t.db);
      const error = await duplicatePage(t.as("bob"), { pageId: w1Page() }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect((error as Error).message).toBe(COPY_FAILED_MESSAGE);
      expect(await snapshotAppTables(t.db)).toEqual(before);
      const created = vi.mocked(copy).mock.results.map((r) => (r.value as Promise<{ pathname: string }>));
      const createdPaths = await Promise.all(created).then((rows) => rows.map((r) => r.pathname));
      expect(del).toHaveBeenCalledWith(createdPaths, { token: SIMULATED_BLOB_TOKEN });
      expect(createdPaths).not.toContain(t.fx.attachments.w1.blobPathname);
    });

    it("Viewer cannot duplicate (403); non-member 404 (no-Blob cases: expansion-no-blob.test.ts)", async () => {
      await expectDeniedUnchanged(() => duplicatePage(t.as("carol"), { pageId: w1Page() }), ForbiddenError);
      await expectDeniedUnchanged(() => duplicatePage(t.as("dave"), { pageId: w1Page() }), NotFoundError);
      expect(copy).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------- E9 move

  describe("AC-53..AC-56 move (E9)", () => {
    /** alice is Owner of W1; give her a destination where she may create pages. */
    async function aliceDestination() {
      const created = await createWorkspace(t.as("alice"), { name: "Alice destination" });
      return created.id;
    }

    it("moves the page AND its files to the destination prefix; originals deleted only after commit", async () => {
      const destination = await aliceDestination();
      const [event] = await t.db
        .insert(calendarEvent)
        .values({
          workspaceId: w1(),
          title: "Stays in W1",
          allDay: true,
          startDate: "2026-11-01",
          endDate: "2026-11-01",
          pageId: w1Page(),
          createdBy: t.fx.users.alice.id,
          updatedBy: t.fx.users.alice.id,
        })
        .returning({ id: calendarEvent.id });

      const result = await movePage(t.as("alice"), { pageId: w1Page(), destinationWorkspaceId: destination });
      expect(result).toEqual({ id: w1Page(), workspaceId: destination, moved: true });

      expect((await readPage(w1Page())).workspaceId).toBe(destination);
      const [moved] = await attachmentsOf(w1Page());
      expect(moved.workspaceId).toBe(destination);
      expect(moved.blobPathname.startsWith(uploadPathPrefix(destination, w1Page()))).toBe(true);
      expect(moved.id).toBe(t.fx.attachments.w1.id); // same attachment identity
      // Order: copy → head → (commit) → del(original).
      const copyOrder = vi.mocked(copy).mock.invocationCallOrder[0];
      const delOrder = vi.mocked(del).mock.invocationCallOrder[0];
      expect(copyOrder).toBeLessThan(delOrder);
      expect(del).toHaveBeenCalledWith([t.fx.attachments.w1.blobPathname], { token: SIMULATED_BLOB_TOKEN });
      expect(store.has(moved.blobPathname)).toBe(true);

      // Source-only members lose access; the event stays in W1 without the link.
      await expect(getPage(t.as("bob"), { pageId: w1Page() })).rejects.toBeInstanceOf(NotFoundError);
      await expect(getAttachmentDownload(t.as("carol"), { attachmentId: moved.id })).rejects.toBeInstanceOf(NotFoundError);
      const [after] = await t.db.select().from(calendarEvent).where(eq(calendarEvent.id, event.id));
      expect(after).toMatchObject({ workspaceId: w1(), pageId: null });

      // Repeating the move is a no-op (idempotent retry).
      await expect(movePage(t.as("alice"), { pageId: w1Page(), destinationWorkspaceId: destination })).resolves.toEqual({
        id: w1Page(),
        workspaceId: destination,
        moved: false,
      });
    });

    it("permissions: Editor in source 403; Viewer in destination 403; non-member 404 — nothing changes", async () => {
      const destination = await aliceDestination();
      await expectDeniedUnchanged(() => movePage(t.as("bob"), { pageId: w1Page(), destinationWorkspaceId: destination }), ForbiddenError);
      // alice is only a Viewer in W2.
      await expectDeniedUnchanged(() => movePage(t.as("alice"), { pageId: w1Page(), destinationWorkspaceId: w2() }), ForbiddenError);
      await expectDeniedUnchanged(() => movePage(t.as("dave"), { pageId: w1Page(), destinationWorkspaceId: w2() }), NotFoundError);
      // A destination the requester does not belong to is 404, not a hint.
      await expectDeniedUnchanged(
        () => movePage(t.as("alice"), { pageId: w1Page(), destinationWorkspaceId: t.fx.workspaces.w3.id }),
        NotFoundError,
      );
      expect(copy).not.toHaveBeenCalled();
    });

    it("AC-55: an attachment added mid-move aborts with 409, cleans the copies, keeps the original; a retry succeeds", async () => {
      const destination = await aliceDestination();
      const intruder = `${uploadPathPrefix(w1(), w1Page())}late-upload-Q1.pdf`;
      vi.mocked(copy).mockImplementationOnce(async (from: string, to: string) => {
        // Another member finishes an upload while the move is copying.
        store.set(intruder, 10);
        await t.db.insert(attachment).values({
          pageId: w1Page(),
          workspaceId: w1(),
          kind: "upload",
          displayName: "late.pdf",
          blobPathname: intruder,
          contentType: "application/pdf",
          sizeBytes: 10,
          createdBy: t.fx.users.bob.id,
        });
        const pathname = to.replace(/(\.[A-Za-z0-9]+)?$/, (ext) => `-Mid1${ext}`);
        store.set(pathname, store.get(from) ?? 0);
        return { pathname } as Awaited<ReturnType<typeof copy>>;
      });

      const error = await movePage(t.as("alice"), { pageId: w1Page(), destinationWorkspaceId: destination }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as Error).message).toBe(ATTACHMENTS_CHANGED_MESSAGE);
      expect((await readPage(w1Page())).workspaceId).toBe(w1());
      const rows = await attachmentsOf(w1Page());
      expect(rows.every((row) => row.workspaceId === w1())).toBe(true);
      // Only the attempt's copy was removed; originals and the new upload remain.
      const attemptCopy = `${uploadPathPrefix(destination, w1Page())}`;
      expect(vi.mocked(del).mock.calls.flatMap((c) => c[0] as string[]).every((p) => p.startsWith(attemptCopy))).toBe(true);
      expect(store.has(t.fx.attachments.w1.blobPathname)).toBe(true);
      expect(store.has(intruder)).toBe(true);

      // Retry: both files are now copied and the move succeeds without duplicates.
      const retry = await movePage(t.as("alice"), { pageId: w1Page(), destinationWorkspaceId: destination });
      expect(retry).toMatchObject({ moved: true, workspaceId: destination });
      const movedRows = await attachmentsOf(w1Page());
      expect(movedRows).toHaveLength(2);
      expect(movedRows.every((row) => row.blobPathname.startsWith(uploadPathPrefix(destination, w1Page())))).toBe(true);
      expect(await t.db.select().from(page).where(and(eq(page.id, w1Page())))).toHaveLength(1);
    });

    it("AC-56: the page trashed while copying → 404, nothing moved, copies cleaned", async () => {
      const destination = await aliceDestination();
      vi.mocked(copy).mockImplementationOnce(async (from: string, to: string) => {
        await trashPage(t.as("bob"), { pageId: w1Page() });
        const pathname = to.replace(/(\.[A-Za-z0-9]+)?$/, (ext) => `-Tr1${ext}`);
        store.set(pathname, store.get(from) ?? 0);
        return { pathname } as Awaited<ReturnType<typeof copy>>;
      });
      const error = await movePage(t.as("alice"), { pageId: w1Page(), destinationWorkspaceId: destination }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundError);
      expect((await readPage(w1Page())).workspaceId).toBe(w1());
      expect(store.has(t.fx.attachments.w1.blobPathname)).toBe(true);
      expect([...store.keys()].some((p) => p.startsWith(uploadPathPrefix(destination, w1Page())))).toBe(false);
    });

    it("AC-56: a stale save after the move is rejected (no write in either workspace)", async () => {
      const destination = await aliceDestination();
      await movePage(t.as("alice"), { pageId: w1Other(), destinationWorkspaceId: destination });
      // bob loaded the page while it was in W1; his save now targets a page he cannot see.
      await expectDeniedUnchanged(() => updatePage(t.as("bob"), { pageId: w1Other(), workspaceId: w1(), title: "stale" }), NotFoundError);
    });
  });

  // ------------------------------------------------------- AC-45 / AC-59

  describe("AC-45 / AC-59 Home and revocation", () => {
    it("Home lists only my live pages; after removal they disappear immediately", async () => {
      const recentBob = await listRecentPages(t.as("bob"));
      expect(recentBob.map((p) => p.workspaceId).every((id) => id === w1())).toBe(true);
      expect(recentBob.length).toBe(2);
      const sidebarAlice = await listSidebarPages(t.as("alice"));
      expect(Object.keys(sidebarAlice).sort()).toEqual([w1(), w2()].sort());

      await removeMember(t.as("alice"), { membershipId: t.fx.memberships["bob:w1"] });
      expect(await listRecentPages(t.as("bob"))).toEqual([]);
      expect(await listSidebarPages(t.as("bob"))).toEqual({});
      await expect(getPage(t.as("bob"), { pageId: w1Page() })).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        listEventsInRange(t.as("bob"), { workspaceId: w1(), from: "2026-11-01", to: "2026-11-30" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await listTrash(t.as("bob"))).toEqual([]);
    });

    it("Recently edited is ordered by updated_at and limited", async () => {
      const recent = await listRecentPages(t.as("alice"), 2);
      expect(recent).toHaveLength(2);
      const times = recent.map((p) => p.updatedAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });
  });
});
