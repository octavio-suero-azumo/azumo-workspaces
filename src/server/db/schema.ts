import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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

export const workspace = pgTable(
  "workspace",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    ...timestamps,
  },
  (table) => [check("workspace_name_length", sql`char_length(${table.name}) between 1 and 100`)],
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

export const page = pgTable(
  "page",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: jsonb("content"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => user.id),
    ...timestamps,
  },
  (table) => [
    // Target of the attachment composite FK (page_id, workspace_id) (AC-25).
    unique("page_id_workspace_unique").on(table.id, table.workspaceId),
    check("page_title_length", sql`char_length(${table.title}) between 1 and 200`),
    index("page_workspace_id_idx").on(table.workspaceId),
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
