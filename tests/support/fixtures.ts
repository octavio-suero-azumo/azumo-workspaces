/**
 * Test fixtures (T-03c, docs/test-plan.md §2). Created by code only, on the
 * placeholder domain `allowed.test`; no real accounts, no production data.
 *
 * | Fixture  | W1     | W2     | W3    |
 * |----------|--------|--------|-------|
 * | alice    | Owner  | Viewer | —     |
 * | bob      | Editor | —      | —     |
 * | carol    | Viewer | —      | —     |
 * | dave     | —      | Owner  | —     |
 * | erin     | —      | —      | Owner |
 * | outsider | —      | —      | —     |
 *
 * Every workspace has at least one page, and its first page has one upload
 * attachment ROW (increment E). The rows point at blob pathnames that do not
 * exist in any Blob store: tests that need blob behaviour mock `@vercel/blob`
 * (SIMULATED); E2E never downloads them successfully.
 */
import { asc, sql } from "drizzle-orm";
import { uploadPathPrefix } from "@/lib/attachment-rules";
import type { Role } from "@/server/authz/permissions";
import type { DataContext } from "@/server/data/context";
import type { AppDatabase } from "@/server/db/client";
import { attachment, membership, page, user, workspace } from "@/server/db/schema";

export const FIXTURE_DOMAIN = "allowed.test";

export const FIXTURE_USER_KEYS = ["alice", "bob", "carol", "dave", "erin", "outsider"] as const;
export type FixtureUserKey = (typeof FIXTURE_USER_KEYS)[number];

export const FIXTURE_WORKSPACE_KEYS = ["w1", "w2", "w3"] as const;
export type FixtureWorkspaceKey = (typeof FIXTURE_WORKSPACE_KEYS)[number];

export const FIXTURE_WORKSPACE_NAMES: Readonly<Record<FixtureWorkspaceKey, string>> = {
  w1: "W1 Product",
  w2: "W2 Marketing",
  w3: "W3 Finance",
};

export const FIXTURE_PAGE_TITLES: Readonly<Record<FixtureWorkspaceKey, readonly string[]>> = {
  w1: ["W1 Roadmap", "W1 Onboarding"],
  w2: ["W2 Campaign plan"],
  w3: ["W3 Budget"],
};

/** One upload attachment on the first page of each workspace. */
export const FIXTURE_ATTACHMENTS: Readonly<
  Record<FixtureWorkspaceKey, { displayName: string; file: string; contentType: string; sizeBytes: number }>
> = {
  w1: { displayName: "W1 roadmap.pdf", file: "w1-roadmap-fx1a2b3c.pdf", contentType: "application/pdf", sizeBytes: 2048 },
  w2: { displayName: "W2 campaign brief.png", file: "w2-campaign-fx4d5e6f.png", contentType: "image/png", sizeBytes: 4096 },
  w3: {
    displayName: "W3 budget.xlsx",
    file: "w3-budget-fx7a8b9c.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 8192,
  },
};

const MEMBERSHIPS = [
  ["alice", "w1", "owner"],
  ["alice", "w2", "viewer"],
  ["bob", "w1", "editor"],
  ["carol", "w1", "viewer"],
  ["dave", "w2", "owner"],
  ["erin", "w3", "owner"],
] as const satisfies ReadonlyArray<readonly [FixtureUserKey, FixtureWorkspaceKey, Role]>;

type MembershipKey = `${(typeof MEMBERSHIPS)[number][0]}:${(typeof MEMBERSHIPS)[number][1]}`;

/** Owner who creates each fixture workspace and its pages. */
const WORKSPACE_OWNER: Readonly<Record<FixtureWorkspaceKey, FixtureUserKey>> = {
  w1: "alice",
  w2: "dave",
  w3: "erin",
};

export interface FixtureUser {
  id: string;
  email: string;
  name: string;
}

export interface FixtureAttachment {
  id: string;
  pageId: string;
  workspaceId: string;
  displayName: string;
  blobPathname: string;
  contentType: string;
  sizeBytes: number;
}

export interface Fixtures {
  users: Record<FixtureUserKey, FixtureUser>;
  workspaces: Record<FixtureWorkspaceKey, { id: string; name: string }>;
  /** Membership ids, keyed `"<user>:<workspace>"`, e.g. `"alice:w2"`. */
  memberships: Record<MembershipKey, string>;
  pages: Record<FixtureWorkspaceKey, Array<{ id: string; title: string }>>;
  /** The attachment on `pages[key][0]`. */
  attachments: Record<FixtureWorkspaceKey, FixtureAttachment>;
}

export function fixtureUserId(key: FixtureUserKey): string {
  return `fixture-${key}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Insert the §2 fixtures into an EMPTY database and return their ids. */
export async function seedFixtures(db: AppDatabase): Promise<Fixtures> {
  const users = Object.fromEntries(
    FIXTURE_USER_KEYS.map((key) => [
      key,
      { id: fixtureUserId(key), email: `${key}@${FIXTURE_DOMAIN}`, name: capitalize(key) },
    ]),
  ) as Record<FixtureUserKey, FixtureUser>;

  await db.insert(user).values(
    FIXTURE_USER_KEYS.map((key) => ({
      ...users[key],
      emailVerified: true,
      googleHd: FIXTURE_DOMAIN,
    })),
  );

  const workspaces = {} as Fixtures["workspaces"];
  for (const key of FIXTURE_WORKSPACE_KEYS) {
    const [row] = await db
      .insert(workspace)
      .values({ name: FIXTURE_WORKSPACE_NAMES[key], createdBy: users[WORKSPACE_OWNER[key]].id })
      .returning({ id: workspace.id, name: workspace.name });
    workspaces[key] = row;
  }

  const memberships = {} as Fixtures["memberships"];
  for (const [userKey, workspaceKey, role] of MEMBERSHIPS) {
    const [row] = await db
      .insert(membership)
      .values({ workspaceId: workspaces[workspaceKey].id, userId: users[userKey].id, role })
      .returning({ id: membership.id });
    memberships[`${userKey}:${workspaceKey}`] = row.id;
  }

  const pages = {} as Fixtures["pages"];
  for (const key of FIXTURE_WORKSPACE_KEYS) {
    const author = users[WORKSPACE_OWNER[key]].id;
    pages[key] = await db
      .insert(page)
      .values(
        FIXTURE_PAGE_TITLES[key].map((title) => ({
          workspaceId: workspaces[key].id,
          title,
          content: { type: "doc", content: [] },
          createdBy: author,
          updatedBy: author,
        })),
      )
      .returning({ id: page.id, title: page.title });
  }

  const attachments = {} as Fixtures["attachments"];
  for (const key of FIXTURE_WORKSPACE_KEYS) {
    const spec = FIXTURE_ATTACHMENTS[key];
    const target = pages[key][0];
    const [row] = await db
      .insert(attachment)
      .values({
        pageId: target.id,
        workspaceId: workspaces[key].id,
        kind: "upload",
        displayName: spec.displayName,
        blobPathname: `${uploadPathPrefix(workspaces[key].id, target.id)}${spec.file}`,
        contentType: spec.contentType,
        sizeBytes: spec.sizeBytes,
        createdBy: users[WORKSPACE_OWNER[key]].id,
      })
      .returning({
        id: attachment.id,
        pageId: attachment.pageId,
        workspaceId: attachment.workspaceId,
        displayName: attachment.displayName,
        blobPathname: attachment.blobPathname,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
      });
    attachments[key] = row;
  }

  return { users, workspaces, memberships, pages, attachments };
}

/** Empty every table (app + auth). Cheap on in-memory PGlite. */
export async function resetDatabase(db: AppDatabase): Promise<void> {
  await db.execute(
    sql.raw(
      'TRUNCATE TABLE "attachment", "page", "membership", "workspace", "verification", "account", "session", "user" CASCADE',
    ),
  );
}

/** Per-test isolation for mutating tests: wipe, then reload the fixtures. */
export async function resetAndSeed(db: AppDatabase): Promise<Fixtures> {
  await resetDatabase(db);
  return seedFixtures(db);
}

/** Requester context for a fixture user (the userId a real session would carry). */
export function ctxFor(db: AppDatabase, fx: Fixtures, key: FixtureUserKey): DataContext {
  return { db, userId: fx.users[key].id };
}

/** Full, ordered copy of the app tables, to prove "no DB change" (PRD §10 "Denied"). */
export async function snapshotAppTables(db: AppDatabase) {
  const [workspaces, memberships, pages, attachments] = await Promise.all([
    db.select().from(workspace).orderBy(asc(workspace.id)),
    db.select().from(membership).orderBy(asc(membership.id)),
    db.select().from(page).orderBy(asc(page.id)),
    db.select().from(attachment).orderBy(asc(attachment.id)),
  ]);
  return { workspaces, memberships, pages, attachments };
}
