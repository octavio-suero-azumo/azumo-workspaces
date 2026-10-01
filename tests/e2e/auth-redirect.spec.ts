import { expect, test } from "@playwright/test";

// TC-06 (E2E part) / AC-01: unauthenticated navigation is redirected to
// /sign-in, and the sign-in page offers Google as the only method.
// No real Google login happens here (TC-40..TC-42 remain manual).

test.describe("unauthenticated access", () => {
  test("GET / redirects to /sign-in", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("another app route redirects to /sign-in", async ({ page }) => {
    await page.goto("/workspaces/some-workspace-id");
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("a forged session cookie is not accepted by the home page", async ({ page, context, baseURL }) => {
    // The proxy only checks that a cookie exists; the page itself validates
    // the session server-side and must still redirect.
    await context.addCookies([
      { name: "better-auth.session_token", value: "forged.signature", url: baseURL ?? "" },
    ]);
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("/sign-in renders the Google button and no other sign-in method", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { name: "Sign in to Azumo Workspaces" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.locator('input[type="email"]')).toHaveCount(0);
  });

  test("/sign-in shows a clear message for a rejected sign-in", async ({ page }) => {
    await page.goto("/sign-in?error=hd_mismatch");
    await expect(page.getByTestId("sign-in-error")).toHaveText(
      "Only accounts from the authorized Google Workspace domain can sign in.",
    );
  });

  test("the auth API is reachable without a session (not redirected) and reports no session", async ({
    request,
  }) => {
    const response = await request.get("/api/auth/get-session", { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(await response.json()).toBeNull();
  });
});
