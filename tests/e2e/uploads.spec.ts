import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Fixtures } from "../support/fixtures";
import { FIXTURES_FILE, storageStatePath } from "./support/paths";

// Increment E E2E (T-13, T-15, T-16). MOCKED auth (test-only sessions, DP8).
//
// There is NO Blob store here: playwright.config.ts pins BLOB_READ_WRITE_TOKEN
// to "" (P4 pending). So this spec asserts only the UI and the REAL
// "not configured" behaviour of the routes. It never fakes a successful
// upload or download; those are SIMULATED in tests/integration/uploads.test.ts
// and verified for real later (TC-43, manual).
//
// Fixture: W1's first page carries one attachment ROW ("W1 roadmap.pdf")
// whose blob does not exist anywhere.

const fx = (): Fixtures => JSON.parse(readFileSync(FIXTURES_FILE, "utf8")) as Fixtures;

const NOT_CONFIGURED = "Uploads are not configured on this server.";

test.describe.configure({ mode: "serial" });

const w1PagePath = () => `/w/${fx().workspaces.w1.id}/p/${fx().pages.w1[0].id}`;

function tokenRequestBody(f: Fixtures) {
  const pageId = f.pages.w1[0].id;
  return {
    type: "blob.generate-client-token",
    payload: {
      pathname: `ws/${f.workspaces.w1.id}/pg/${pageId}/e2e.pdf`,
      clientPayload: JSON.stringify({ pageId, size: 100, contentType: "application/pdf" }),
      multipart: false,
    },
  };
}

/** The raw server HTML (including the RSC payload) must not carry blob URLs or pathnames (AC-24). */
function expectNoBlobDataIn(html: string, f: Fixtures) {
  expect(html).not.toContain("vercel-storage.com");
  expect(html).not.toContain(f.attachments.w1.blobPathname);
  expect(html).not.toContain(`ws/${f.workspaces.w1.id}/pg/`);
}

async function attachmentsOf(page: Page) {
  return page.getByTestId("attachments");
}

test.describe("bob (Editor of W1)", () => {
  test.use({ storageState: storageStatePath("bob") });

  test("AC-20/AC-18: sees the list with app-route links, the upload control, and 'uploads not configured'", async ({ page }) => {
    const f = fx();
    const response = await page.goto(w1PagePath());
    expect(response?.status()).toBe(200);
    expectNoBlobDataIn(await response!.text(), f);

    const section = await attachmentsOf(page);
    await expect(section.getByRole("heading", { name: "Attachments" })).toBeVisible();
    await expect(section.getByTestId("attachment-item")).toHaveCount(1);
    const link = section.getByTestId("attachment-download");
    await expect(link).toHaveText(f.attachments.w1.displayName);
    await expect(link).toHaveAttribute("href", `/api/files/${f.attachments.w1.id}`);

    // Owner/Editor see the upload control; without a Blob token it is disabled with a clear message.
    const form = page.getByTestId("upload-form");
    await expect(form).toBeVisible();
    await expect(form.getByLabel("Attach a file")).toBeDisabled();
    await expect(form.getByRole("button", { name: "Upload" })).toBeDisabled();
    await expect(page.getByTestId("uploads-not-configured")).toHaveText(NOT_CONFIGURED);

    await expect(section.getByRole("button", { name: `Delete file ${f.attachments.w1.displayName}` })).toBeVisible();
    expectNoBlobDataIn(await page.content(), f);
  });

  test("the routes fail closed for real without a Blob token: token 503, download 503", async ({ page }) => {
    const f = fx();
    await page.goto(w1PagePath());

    const token = await page.request.post("/api/uploads", { data: tokenRequestBody(f) });
    expect(token.status()).toBe(503);
    expect(await token.json()).toEqual({ error: { code: "UNAVAILABLE", message: NOT_CONFIGURED } });

    const download = await page.request.get(`/api/files/${f.attachments.w1.id}`, { maxRedirects: 0 });
    expect(download.status()).toBe(503);
    expect(await download.json()).toEqual({ error: { code: "UNAVAILABLE", message: NOT_CONFIGURED } });
  });
});

test.describe("carol (Viewer of W1)", () => {
  test.use({ storageState: storageStatePath("carol") });

  test("AC-18/AC-20: sees the file and its download link, but no upload control and no delete", async ({ page }) => {
    const f = fx();
    const response = await page.goto(w1PagePath());
    expectNoBlobDataIn(await response!.text(), f);

    const section = await attachmentsOf(page);
    await expect(section.getByTestId("attachment-download")).toHaveText(f.attachments.w1.displayName);
    await expect(section.getByTestId("attachment-download")).toHaveAttribute("href", `/api/files/${f.attachments.w1.id}`);
    await expect(page.getByTestId("upload-form")).toHaveCount(0);
    await expect(page.getByTestId("uploads-not-configured")).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Delete file/ })).toHaveCount(0);
    await expect(page.locator("main").getByRole("button")).toHaveCount(0);
  });

  test("routes: token 403 (authorization before configuration), download 503, W2's file 404", async ({ page }) => {
    const f = fx();
    await page.goto(w1PagePath());
    expect((await page.request.post("/api/uploads", { data: tokenRequestBody(f) })).status()).toBe(403);
    expect((await page.request.get(`/api/files/${f.attachments.w1.id}`)).status()).toBe(503);
    const foreign = await page.request.get(`/api/files/${f.attachments.w2.id}`);
    expect(foreign.status()).toBe(404);
    const body = await foreign.text();
    expect(body).not.toContain(f.attachments.w2.displayName);
    expect(body).not.toContain(f.workspaces.w2.name);
  });
});

test.describe("outsider (no memberships)", () => {
  test.use({ storageState: storageStatePath("outsider") });

  test("AC-10: W1's file and page are 404; the token route is 404", async ({ page }) => {
    const f = fx();
    expect((await page.goto(w1PagePath()))?.status()).toBe(404);
    const download = await page.request.get(`/api/files/${f.attachments.w1.id}`);
    expect(download.status()).toBe(404);
    expect(await download.text()).not.toContain(f.attachments.w1.displayName);
    expect((await page.request.post("/api/uploads", { data: tokenRequestBody(f) })).status()).toBe(404);
  });
});

test.describe("unauthenticated", () => {
  test("AC-01: both routes answer 401 (no redirect, no data)", async ({ request }) => {
    const f = fx();
    const download = await request.get(`/api/files/${f.attachments.w1.id}`, { maxRedirects: 0 });
    expect(download.status()).toBe(401);
    expect(await download.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Authentication required." } });
    const token = await request.post("/api/uploads", { data: tokenRequestBody(f), maxRedirects: 0 });
    expect(token.status()).toBe(401);
  });
});

// Mutates the fixture (deletes W1's attachment row): keep it last.
test.describe("bob deletes the attachment (row delete works without a Blob store)", () => {
  test.use({ storageState: storageStatePath("bob") });

  test("AC-26 (UI + row): confirm step, the file leaves the list, the download is 404 afterwards", async ({ page }) => {
    const f = fx();
    await page.goto(w1PagePath());
    const section = await attachmentsOf(page);

    await section.getByRole("button", { name: `Delete file ${f.attachments.w1.displayName}` }).click();
    const confirm = section.getByTestId("delete-attachment-confirm");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(section.getByTestId("attachment-item")).toHaveCount(1);

    await section.getByRole("button", { name: `Delete file ${f.attachments.w1.displayName}` }).click();
    await section.getByTestId("delete-attachment-confirm").getByRole("button", { name: "Yes, delete file" }).click();
    await expect(section.getByTestId("attachment-item")).toHaveCount(0);
    await expect(section.getByTestId("attachments-empty")).toHaveText("No files attached.");

    await page.reload();
    await expect(page.getByTestId("attachment-item")).toHaveCount(0);
    expect((await page.request.get(`/api/files/${f.attachments.w1.id}`)).status()).toBe(404);
  });
});
