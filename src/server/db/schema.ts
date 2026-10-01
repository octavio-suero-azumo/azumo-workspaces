import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
// Relative imports on purpose: drizzle-kit loads this file without the `@/` alias.
import { ATTACHMENT_DISPLAY_NAME_MAX, ATTACHMENT_KINDS } from "../../lib/attachment-rules";
import { EVENT_DESCRIPTION_MAX, EVENT_TITLE_MAX } from "../../lib/calendar";
import { PAGE_FONTS } from "../../lib/page-presentation";
import { ROLES } from "../authz/permissions";

/**
 * Drizzle schema: Better Auth core tables (T-03a) and the app tables
 * `workspace`, `membership`, `page` (T-03b) and `attachment` (T-13), further below.
 *
 * Written by hand following Better Auth 1.7.6's core schema
 * (`@better-auth/core/db` get-tables): tables `user`, `session`, `account`,
 * `verification`. Better Auth's drizzle adapter validates this object at
 * runtime (`advanced.database.validateSchema`, on by default), so a missing or
 * renamed field fails loudly.
 *
 * Pinned strategy (architecture §3 note, RV-20):
 * - IDs: Better Auth's default generated **text** IDs (random alphanumeric).
 *   Every app table that references a user uses a `text` FK to `user.id`.
 *   App-owned tables (workspace, membership, page, attachment) may use their
 *   own `uuid` primary keys; only FKs to `user.id` must be `text`.
 * - Names: TypeScript property keys are camelCase and must equal Better Auth's
 *   field names (the adapter addresses columns by property key). SQL column
 *   names are snake_case.
 * - Timestamps are `timestamptz`.
 */

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  /**
   * Google Workspace hosted domain (`hd` ID-token claim) captured at user
   * creation through `mapProfileToUser`. Re-checked against the current
   * `ALLOWED_GOOGLE_HD` before every session is created (R1.2, RK-1).
   * Immutable after creation (see `databaseHooks.user.update.before`).
   */
  googleHd: text("google_hd"),
  ...timestamps,
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

/** Tables handed to Better Auth's drizzle adapter. */
export const authSchema = { user, session, account, verification };

/*
 * App tables (T-03b, architecture §3). UUID primary keys; FKs to `user.id`
 * are `text` (Better Auth IDs). Length limits are enforced in the DB with
 * CHECK constraints and validated (after trimming) in the data layer.
 */

/** `'owner', 'editor', 'viewer'` for the role CHECK, generated from `ROLES`. */
const ROLE_LIST_SQL = sql.raw(ROLES.map((role) => `'${role}'`).join(", "));

/**
 * Icons (scope expansion E2, 2026-10-01) are emoji strings from the curated
 * allowlist in `src/lib/icons.ts`, validated in the data layer. The DB only
 * bounds their length; NULL means "default icon".
 */
const ICON_MAX_CODE_POINTS = 16;

export const workspace = pgTable(
  "workspace",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    icon: text("icon"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    ...timestamps,
  },
  (table) => [
    check("workspace_name_length", sql`char_length(${table.name}) between 1 and 100`),
    check(
      "workspace_icon_length",
      sql`${table.icon} is null or char_length(${table.icon}) between 1 and ${sql.raw(String(ICON_MAX_CODE_POINTS))}`,
    ),
  ],
);

export const membership = pgTable(
  "membership",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // R3.1: at most one membership per (workspace, user).
    unique("membership_workspace_user_unique").on(table.workspaceId, table.userId),
    // R3.1 / PR3: exactly one role from the configured set.
    check("membership_role_valid", sql`${table.role} in (${ROLE_LIST_SQL})`),
    index("membership_user_id_idx").on(table.userId),
  ],
);

/** `'default', 'serif', 'mono'` for the font CHECK, generated from `PAGE_FONTS`. */
const PAGE_FONT_LIST_SQL = sql.raw(PAGE_FONTS.map((font) => `'${font}'`).join(", "));

/**
 * Pages. Scope expansion 2026-10-01 adds:
 * - `icon` (E2) and the per-page presentation `font` / `small_text` /
 *   `full_width` (E5), shared by every member, changed by Owner/Editor;
 * - soft delete (E10, DP13): `deleted_at` + `deleted_by`, always set or
 *   cleared together. A trashed page resolves only for `page.restore`
 *   (`src/server/data/access.ts`); every other read and write filters
 *   `deleted_at IS NULL`.
 */
export const page = pgTable(
  "page",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: jsonb("content"),
    icon: text("icon"),
    font: text("font").notNull().default("default"),
    smallText: boolean("small_text").notNull().default(false),
    fullWidth: boolean("full_width").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: text("deleted_by").references(() => user.id),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => user.id),
    ...timestamps,
  },
  (table) => [
    // Target of the attachment composite FK (page_id, workspace_id) (AC-25)
    // and of the calendar event → page FK (E4).
    unique("page_id_workspace_unique").on(table.id, table.workspaceId),
    check("page_title_length", sql`char_length(${table.title}) between 1 and 200`),
    check(
      "page_icon_length",
      sql`${table.icon} is null or char_length(${table.icon}) between 1 and ${sql.raw(String(ICON_MAX_CODE_POINTS))}`,
    ),
    check("page_font_valid", sql`${table.font} in (${PAGE_FONT_LIST_SQL})`),
    check("page_trash_pair", sql`(${table.deletedAt} is null) = (${table.deletedBy} is null)`),
    index("page_workspace_id_idx").on(table.workspaceId),
    // Home "Recently edited" and the sidebar read live pages by workspace.
    index("page_live_updated_idx")
      .on(table.workspaceId, table.updatedAt.desc())
      .where(sql`${table.deletedAt} is null`),
  ],
);

/** `'upload'` for the kind CHECK, generated from `ATTACHMENT_KINDS` (P2). */
const ATTACHMENT_KIND_LIST_SQL = sql.raw(ATTACHMENT_KINDS.map((kind) => `'${kind}'`).join(", "));

/**
 * File attached to a page (T-13, architecture §3, P2 = uploads to a PRIVATE
 * Vercel Blob store). The row stores the blob PATHNAME only, never a URL;
 * files are served exclusively through `GET /api/files/{id}` (T-16).
 *
 * - `workspace_id` is denormalized for workspace-scoped queries. The composite
 *   FK (page_id, workspace_id) → page(id, workspace_id) makes a mismatched
 *   workspace impossible (AC-25) and cascades page deletion (DP4).
 * - `blob_pathname` must live under `ws/{workspace_id}/pg/{page_id}/`
 *   (defense in depth for the upload prefix check, AC-38).
 */
export const attachment = pgTable(
  "attachment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    blobPathname: text("blob_pathname").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "attachment_page_workspace_fk",
      columns: [table.pageId, table.workspaceId],
      foreignColumns: [page.id, page.workspaceId],
    }).onDelete("cascade"),
    unique("attachment_blob_pathname_unique").on(table.blobPathname),
    check("attachment_kind_valid", sql`${table.kind} in (${ATTACHMENT_KIND_LIST_SQL})`),
    check(
      "attachment_display_name_length",
      sql`char_length(${table.displayName}) between 1 and ${sql.raw(String(ATTACHMENT_DISPLAY_NAME_MAX))}`,
    ),
    check(
      "attachment_blob_pathname_prefix",
      sql`starts_with(${table.blobPathname}, 'ws/' || ${table.workspaceId}::text || '/pg/' || ${table.pageId}::text || '/')`,
    ),
    check("attachment_size_non_negative", sql`${table.sizeBytes} >= 0`),
    index("attachment_page_id_idx").on(table.pageId),
    index("attachment_workspace_id_idx").on(table.workspaceId),
  ],
);

/**
 * Calendar events (scope expansion E4, 2026-10-01). One workspace each;
 * Owner/Editor write, every member reads.
 *
 * - ALL-DAY: `start_date`/`end_date` (DATE, end INCLUSIVE). Never converted
 *   between time zones, so the event keeps its calendar day for everyone.
 * - TIMED: `start_at`/`end_at` (timestamptz) + the author's IANA `time_zone`.
 *   The shape CHECK makes the two forms mutually exclusive.
 * - Optional related page of the SAME workspace: the composite FK
 *   (page_id, workspace_id) → page(id, workspace_id) makes a cross-workspace
 *   link impossible. On page delete only `page_id` is nulled: the migration
 *   uses `ON DELETE SET NULL ("page_id")` (PostgreSQL ≥ 15). Drizzle cannot
 *   express a column list, so the generated SQL was hand-edited and the
 *   definition is pinned by tests/integration/schema-expansion.test.ts.
 *   Moving a page clears the link (the event stays in its workspace).
 */
export const calendarEvent = pgTable(
  "calendar_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    pageId: uuid("page_id"),
    title: text("title").notNull(),
    description: text("description"),
    allDay: boolean("all_day").notNull(),
    startDate: date("start_date", { mode: "string" }),
    endDate: date("end_date", { mode: "string" }),
    startAt: timestamp("start_at", { withTimezone: true }),
    endAt: timestamp("end_at", { withTimezone: true }),
    timeZone: text("time_zone"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => user.id),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "calendar_event_page_workspace_fk",
      columns: [table.pageId, table.workspaceId],
      foreignColumns: [page.id, page.workspaceId],
    }).onDelete("set null"),
    check(
      "calendar_event_title_length",
      sql`char_length(${table.title}) between 1 and ${sql.raw(String(EVENT_TITLE_MAX))}`,
    ),
    check(
      "calendar_event_description_length",
      sql`${table.description} is null or char_length(${table.description}) <= ${sql.raw(String(EVENT_DESCRIPTION_MAX))}`,
    ),
    check(
      "calendar_event_time_zone_length",
      sql`${table.timeZone} is null or char_length(${table.timeZone}) between 1 and 64`,
    ),
    check(
      "calendar_event_shape",
      sql`(${table.allDay} and ${table.startDate} is not null and ${table.endDate} is not null and ${table.endDate} >= ${table.startDate} and ${table.startAt} is null and ${table.endAt} is null and ${table.timeZone} is null)
        or (not ${table.allDay} and ${table.startAt} is not null and ${table.endAt} is not null and ${table.endAt} > ${table.startAt} and ${table.timeZone} is not null and ${table.startDate} is null and ${table.endDate} is null)`,
    ),
    index("calendar_event_workspace_start_date_idx").on(table.workspaceId, table.startDate),
    index("calendar_event_workspace_start_at_idx").on(table.workspaceId, table.startAt),
    index("calendar_event_page_id_idx").on(table.pageId),
  ],
);
