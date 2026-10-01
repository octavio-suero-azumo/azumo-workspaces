import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { attachment, membership, page, user, workspace } from "@/server/db/schema";
import { FIXTURE_ATTACHMENTS, FIXTURE_DOMAIN, FIXTURE_USER_KEYS } from "../support/fixtures";
import { useFixtureDb } from "../support/fixture-db";

// T-03c self-test: the fixtures match docs/test-plan.md §2 and the per-test
// reset really isolates mutating tests.
describe("fixture harness (T-03c)", () => {
  const t = useFixtureDb();

  it("seeds the six fixture users on the placeholder domain", async () => {
    const rows = await t.db.select().from(user);
    expect(rows.map((r) => r.email).sort()).toEqual(FIXTURE_USER_KEYS.map((k) => `${k}@${FIXTURE_DOMAIN}`).sort());
    expect(rows.every((r) => r.googleHd === FIXTURE_DOMAIN && r.emailVerified)).toBe(true);
  });

  it("seeds exactly the §2 membership table", async () => {
    const rows = await t.db
      .select({ userId: membership.userId, workspaceId: membership.workspaceId, role: membership.role })
      .from(membership);
    const { users, workspaces } = t.fx;
    const byId = (id: string) => Object.entries(workspaces).find(([, w]) => w.id === id)?.[0];
    const userKey = (id: string) => Object.entries(users).find(([, u]) => u.id === id)?.[0];
    const table = rows.map((r) => `${userKey(r.userId)}:${byId(r.workspaceId)}:${r.role}`).sort();
    expect(table).toEqual(
      [
        "alice:w1:owner",
        "alice:w2:viewer",
        "bob:w1:editor",
        "carol:w1:viewer",
        "dave:w2:owner",
        "erin:w3:owner",
      ].sort(),
    );
  });

  it("gives every workspace at least one page", async () => {
    for (const w of Object.values(t.fx.workspaces)) {
      const [{ n }] = await t.db.select({ n: count() }).from(page).where(eq(page.workspaceId, w.id));
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  it("gives every workspace one attachment on its first page (test-plan §2, increment E)", async () => {
    for (const key of ["w1", "w2", "w3"] as const) {
      const rows = await t.db.select().from(attachment).where(eq(attachment.workspaceId, t.fx.workspaces[key].id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: t.fx.attachments[key].id,
        pageId: t.fx.pages[key][0].id,
        kind: "upload",
        blobPathname: `ws/${t.fx.workspaces[key].id}/pg/${t.fx.pages[key][0].id}/${FIXTURE_ATTACHMENTS[key].file}`,
      });
    }
  });

  it("mutation in one test (part 1): delete every workspace", async () => {
    await t.db.delete(workspace);
    const [{ n }] = await t.db.select({ n: count() }).from(workspace);
    expect(n).toBe(0);
  });

  it("mutation in one test (part 2): the next test starts from fresh fixtures", async () => {
    const [{ n }] = await t.db.select({ n: count() }).from(workspace);
    expect(n).toBe(3);
    const [{ m }] = await t.db.select({ m: count() }).from(membership);
    expect(m).toBe(6);
  });
});
