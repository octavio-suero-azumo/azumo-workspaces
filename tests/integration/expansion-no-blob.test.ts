import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { duplicatePage, movePage } from "@/server/data/page-transfer";
import { createWorkspace } from "@/server/data/workspaces";
import { ServiceUnavailableError } from "@/server/errors";
import { snapshotAppTables } from "../support/fixtures";
import { useFixtureDb } from "../support/fixture-db";

// AC-54 (E8/E9) with uploads NOT configured (no BLOB_READ_WRITE_TOKEN, set
// before the first getEnv() of this file): files cannot be copied, so a
// Duplicate/Move of a page WITH attachments is a 503 that changes nothing,
// while pages without attachments still work (no Blob needed).

describe("duplicate / move without Blob configuration", () => {
  const t = useFixtureDb();

  beforeAll(() => {
    vi.stubEnv("ALLOWED_GOOGLE_HD", "allowed.test");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("UPLOAD_MAX_BYTES", "");
    vi.stubEnv("UPLOAD_ALLOWED_TYPES", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("VERCEL_ENV", "");
  });
  afterAll(() => vi.unstubAllEnvs());

  async function expect503Unchanged(call: () => Promise<unknown>) {
    const before = await snapshotAppTables(t.db);
    await expect(call()).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(await snapshotAppTables(t.db)).toEqual(before);
  }

  it("a page WITH files: duplicate and move are 503, nothing changes", async () => {
    const destination = (await createWorkspace(t.as("alice"), { name: "Dest" })).id;
    await expect503Unchanged(() => duplicatePage(t.as("bob"), { pageId: t.fx.pages.w1[0].id }));
    await expect503Unchanged(() =>
      movePage(t.as("alice"), { pageId: t.fx.pages.w1[0].id, destinationWorkspaceId: destination }),
    );
  });

  it("a page WITHOUT files: duplicate and move work without Blob", async () => {
    const destination = (await createWorkspace(t.as("alice"), { name: "Dest" })).id;
    await expect(duplicatePage(t.as("bob"), { pageId: t.fx.pages.w1[1].id })).resolves.toMatchObject({
      workspaceId: t.fx.workspaces.w1.id,
    });
    await expect(
      movePage(t.as("alice"), { pageId: t.fx.pages.w1[1].id, destinationWorkspaceId: destination }),
    ).resolves.toMatchObject({ workspaceId: destination, moved: true });
  });
});
