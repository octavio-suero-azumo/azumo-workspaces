import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import e2eConfig from "../../playwright.config";
import visualConfig from "../../playwright.visual.config";
import type { Fixtures } from "../support/fixtures";
import { FIXTURES_FILE, storageStatePath } from "../e2e/support/paths";

// ============================================================================
// Isolation preflight for the visual baseline (QA, 2026-10-01). TEST-ONLY.
// The `ui-baseline` project depends on this project: if any check here fails,
// no screenshot is taken.
//
// Label: REAL run against the isolated test server. Auth is SIMULATED (DP8
// test-only sessions); nothing here contacts Google, Neon or Vercel Blob. The
// Google authorization URL below is only parsed, never requested.
// Assertion messages never echo env values (only booleans are compared).
// ============================================================================

const EMPTY_STATE = { cookies: [], origins: [] };

const fx = (): Fixtures => JSON.parse(readFileSync(FIXTURES_FILE, "utf8")) as Fixtures;

test.describe("visual baseline isolation preflight", () => {
  test("the visual config reuses the E2E webServer and globalSetup by reference (no second, unpinned server)", () => {
    expect(visualConfig.webServer === e2eConfig.webServer, "same webServer object").toBe(true);
    expect(visualConfig.globalSetup).toBe(e2eConfig.globalSetup);
    expect(visualConfig.testDir).toBe("./tests/visual");
    expect(e2eConfig.testDir).toBe("./tests/e2e");
  });

  test("the running server builds its Google URL from the pinned placeholders (not the real OAuth client)", async ({
    playwright,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    const api = await playwright.request.newContext({ baseURL, storageState: EMPTY_STATE });
    try {
      const response = await api.post("/api/auth/sign-in/social", {
        data: { provider: "google", callbackURL: "/" },
        headers: { origin },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { url?: unknown };
      expect(typeof body.url, "an authorization URL is returned").toBe("string");
      const url = new URL(body.url as string);
      expect(url.hostname === "accounts.google.com", "Google authorization endpoint").toBe(true);
      expect((url.searchParams.get("client_id") ?? "").startsWith("test-placeholder-"), "client_id is the test placeholder").toBe(
        true,
      );
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      expect(redirect.startsWith(`${origin}/api/auth/callback/google`), "redirect_uri is the local test server").toBe(true);
      expect(url.searchParams.get("hd") === "allowed.test", "hd is the placeholder test domain").toBe(true);
    } finally {
      await api.dispose();
    }
  });

  test("the database is the seeded fixture PGlite and Blob storage is not configured", async ({ browser }) => {
    const f = fx();
    const context = await browser.newContext({ storageState: storageStatePath("bob") });
    try {
      const page = await context.newPage();
      const response = await page.goto(`/w/${f.workspaces.w1.id}/p/${f.pages.w1[0].id}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("signed-in-as")).toHaveText("bob@allowed.test");
      await expect(page.getByTestId("uploads-not-configured")).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
