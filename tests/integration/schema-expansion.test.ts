import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "@/server/db/client";
import { calendarEvent, page, workspace } from "@/server/db/schema";
import { expectPgError, PG_CHECK_VIOLATION, PG_FOREIGN_KEY_VIOLATION } from "../support/pg-error";
import { useFixtureDb } from "../support/fixture-db";

// Scope expansion E1–E10 (PRD §12.2), migrations 0003–0005.
// AC-39: a database at migration 0002 holding data migrates to 0005 with the
//        data unchanged (the production upgrade path).
// AC-40: the new DB constraints reject invalid icons, fonts, trash pairs,
//        event shapes and cross-workspace event→page links; deleting a page
//        nulls only the event's page_id.

const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;

describe("AC-39: migrations 0003–0005 upgrade a 0002 database without changing its data", () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  /** A copy of drizzle/ containing only migrations 0000–0002 (the state production was in). */
  function migrationsUpTo0002(): string {
    const dir = mkdtempSync(join(tmpdir(), "azumo-mig-0002-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "meta"));
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const kept = journal.entries.filter((entry) => entry.idx <= 2);
    expect(kept.map((entry) => entry.tag)).toEqual([
      "0000_auth_tables",
      "0001_workspaces_members_pages",
      "0002_attachments",
    ]);
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
    for (const entry of kept) copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
    return dir;
  }

  it("1 user / 1 workspace / 1 page / 1 attachment survive 0003–0005 with safe defaults", async () => {
    const client = new PGlite();
    try {
      const db = drizzle({ client });
      await migrate(db, { migrationsFolder: migrationsUpTo0002() });

      // Data shaped like production before the expansion (raw SQL: the new
      // columns do not exist yet at 0002).
      await client.exec(`
        insert into "user" (id, name, email, email_verified, google_hd) values ('u1', 'User One', 'u1@allowed.test', true, 'allowed.test');
        insert into workspace (id, name, created_by) values ('11111111-1111-4111-8111-111111111111', 'Before', 'u1');
        insert into membership (workspace_id, user_id, role) values ('11111111-1111-4111-8111-111111111111', 'u1', 'owner');
        insert into page (id, workspace_id, title, content, created_by, updated_by)
          values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Old page',
                  '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"kept"}]}]}', 'u1', 'u1');
        insert into attachment (page_id, workspace_id, kind, display_name, blob_pathname, content_type, size_bytes, created_by)
          values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'upload', 'a.pdf',
                  'ws/11111111-1111-4111-8111-111111111111/pg/22222222-2222-4222-8222-222222222222/a-x1.pdf', 'application/pdf', 42, 'u1');
      `);
      const before = await client.query(
        `select (select row_to_json(p) from (select id, workspace_id, title, content, created_at, updated_at from page) p) as page,
                (select row_to_json(a) from (select id, page_id, workspace_id, blob_pathname, size_bytes from attachment) a) as attachment,
                (select count(*)::int from membership) as memberships`,
      );

      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

      const after = await client.query(
        `select (select row_to_json(p) from (select id, workspace_id, title, content, created_at, updated_at from page) p) as page,
                (select row_to_json(a) from (select id, page_id, workspace_id, blob_pathname, size_bytes from attachment) a) as attachment,
                (select count(*)::int from membership) as memberships`,
      );
      expect(after.rows).toEqual(before.rows);

      const defaults = await client.query<{
        icon: string | null;
        font: string;
        small_text: boolean;
        full_width: boolean;
        deleted_at: string | null;
        workspace_icon: string | null;
      }>(
        `select p.icon, p.font, p.small_text, p.full_width, p.deleted_at, w.icon as workspace_icon
         from page p join workspace w on w.id = p.workspace_id`,
      );
      expect(defaults.rows).toEqual([
        { icon: null, font: "default", small_text: false, full_width: false, deleted_at: null, workspace_icon: null },
      ]);
      const events = await client.query<{ n: number }>("select count(*)::int as n from calendar_event");
      expect(events.rows).toEqual([{ n: 0 }]);

      // Re-running is a no-op (already-applied migrations are skipped).
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const again = await client.query(
        `select (select row_to_json(p) from (select id, workspace_id, title, content, created_at, updated_at from page) p) as page,
                (select row_to_json(a) from (select id, page_id, workspace_id, blob_pathname, size_bytes from attachment) a) as attachment,
                (select count(*)::int from membership) as memberships`,
      );
      expect(again.rows).toEqual(before.rows);
    } finally {
      await client.close();
    }
  });

  it("the server is PostgreSQL ≥ 15 (needed for ON DELETE SET NULL (page_id))", async () => {
    const client = new PGlite();
    try {
      const result = await client.query<{ v: number }>("select current_setting('server_version_num')::int as v");
      expect(result.rows[0].v).toBeGreaterThanOrEqual(150000);
    } finally {
      await client.close();
    }
  });
});

describe("AC-40: new DB constraints (defense in depth below the data layer)", () => {
  const t = useFixtureDb();
  const w1 = () => t.fx.workspaces.w1.id;
  const w1Page = () => t.fx.pages.w1[0].id;
  const alice = () => t.fx.users.alice.id;

  it("page.font accepts only default/serif/mono", async () => {
    const error = await expectPgError(() => t.db.update(page).set({ font: "comic" }).where(eq(page.id, w1Page())));
    expect(error).toMatchObject({ code: PG_CHECK_VIOLATION, constraint: "page_font_valid" });
  });

  it("icons are bounded (≤ 16 code points) on pages and workspaces", async () => {
    const pageError = await expectPgError(() => t.db.update(page).set({ icon: "x".repeat(17) }).where(eq(page.id, w1Page())));
    expect(pageError).toMatchObject({ code: PG_CHECK_VIOLATION, constraint: "page_icon_length" });
    const wsError = await expectPgError(() => t.db.update(workspace).set({ icon: "" }).where(eq(workspace.id, w1())));
    expect(wsError).toMatchObject({ code: PG_CHECK_VIOLATION, constraint: "workspace_icon_length" });
  });

  it("deleted_at and deleted_by are always set or cleared together", async () => {
    const onlyDate = await expectPgError(() =>
      t.db.update(page).set({ deletedAt: new Date() }).where(eq(page.id, w1Page())),
    );
    expect(onlyDate).toMatchObject({ code: PG_CHECK_VIOLATION, constraint: "page_trash_pair" });
    const onlyActor = await expectPgError(() => t.db.update(page).set({ deletedBy: alice() }).where(eq(page.id, w1Page())));
    expect(onlyActor).toMatchObject({ code: PG_CHECK_VIOLATION, constraint: "page_trash_pair" });
  });

  const baseEvent = () => ({ workspaceId: w1(), title: "E", createdBy: alice(), updatedBy: alice() });

  it.each([
    ["all-day without dates", { allDay: true }],
    ["all-day ending before it starts", { allDay: true, startDate: "2026-11-02", endDate: "2026-11-01" }],
    [
      "all-day carrying instants",
      { allDay: true, startDate: "2026-11-01", endDate: "2026-11-01", startAt: new Date("2026-11-01T10:00:00Z") },
    ],
    ["timed without a time zone", { allDay: false, startAt: new Date("2026-11-01T10:00:00Z"), endAt: new Date("2026-11-01T11:00:00Z") }],
    [
      "timed ending at its start",
      {
        allDay: false,
        startAt: new Date("2026-11-01T10:00:00Z"),
        endAt: new Date("2026-11-01T10:00:00Z"),
        timeZone: "UTC",
      },
    ],
    [
      "timed carrying dates",
      {
        allDay: false,
        startAt: new Date("2026-11-01T10:00:00Z"),
        endAt: new Date("2026-11-01T11:00:00Z"),
        timeZone: "UTC",
        startDate: "2026-11-01",
        endDate: "2026-11-01",
      },
    ],
  ])("calendar_event_shape rejects %s", async (_label, fields) => {
    const error = await expectPgError(() => t.db.insert(calendarEvent).values({ ...baseEvent(), ...fields }));
    expect(error).toMatchObject({ code: PG_CHECK_VIOLATION, constraint: "calendar_event_shape" });
  });

  it("an event can never link to a page of another workspace (composite FK)", async () => {
    const error = await expectPgError(() =>
      t.db.insert(calendarEvent).values({
        ...baseEvent(),
        allDay: true,
        startDate: "2026-11-01",
        endDate: "2026-11-01",
        pageId: t.fx.pages.w2[0].id,
      }),
    );
    expect(error).toMatchObject({ code: PG_FOREIGN_KEY_VIOLATION, constraint: "calendar_event_page_workspace_fk" });
  });

  it("deleting a page (SQL) nulls only the event's page_id; the event stays in its workspace", async () => {
    const [event] = await t.db
      .insert(calendarEvent)
      .values({ ...baseEvent(), allDay: true, startDate: "2026-11-01", endDate: "2026-11-01", pageId: t.fx.pages.w1[1].id })
      .returning({ id: calendarEvent.id });
    await t.db.delete(page).where(eq(page.id, t.fx.pages.w1[1].id));
    const [after] = await t.db.select().from(calendarEvent).where(eq(calendarEvent.id, event.id));
    expect(after).toMatchObject({ pageId: null, workspaceId: w1() });
  });

  it("the event FK definition is pinned: ON DELETE SET NULL (page_id)", async () => {
    const result = await t.db.execute(
      sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'calendar_event_page_workspace_fk'`,
    );
    expect(rowsOf<{ def: string }>(result)).toEqual([
      { def: "FOREIGN KEY (page_id, workspace_id) REFERENCES page(id, workspace_id) ON DELETE SET NULL (page_id)" },
    ]);
  });

  it("all-day dates come back as the exact YYYY-MM-DD strings (never shifted through a Date)", async () => {
    const [event] = await t.db
      .insert(calendarEvent)
      .values({ ...baseEvent(), allDay: true, startDate: "2026-11-01", endDate: "2026-11-03" })
      .returning({ startDate: calendarEvent.startDate, endDate: calendarEvent.endDate });
    expect(event).toEqual({ startDate: "2026-11-01", endDate: "2026-11-03" });
  });
});
