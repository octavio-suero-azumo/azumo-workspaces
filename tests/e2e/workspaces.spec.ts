import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Fixtures } from "../support/fixtures";
import { FIXTURES_FILE, storageStatePath } from "./support/paths";

// Authenticated E2E for increment C (MOCKED auth: sessions come from the
// test-only helper, DP8; no real Google login). The server under test and the
// fixtures share one in-memory PGlite served over a local socket.
//
// TC-09 (AC-08), TC-11 (AC-13), TC-12 UI part (AC-37, AC-18), TC-18 (AC-18),
// TC-19 URL part (AC-10), AC-09 through the real server action, T-09 member
// actions through the real server actions.

const fx = (): Fixtures => JSON.parse(readFileSync(FIXTURES_FILE, "utf8")) as Fixtures;

const main = (page: Page) => page.locator("main");

async function expectNoMemberControls(page: Page) {
  await expect(main(page).getByTestId("add-member-form")).toHaveCount(0);
  await expect(main(page).getByRole("button", { name: "Save role" })).toHaveCount(0);
  await expect(main(page).getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(main(page).getByRole("combobox")).toHaveCount(0);
  await expect(main(page).getByRole("textbox")).toHaveCount(0);
}

test.describe("unauthenticated", () => {
  test("a workspace URL redirects to /sign-in", async ({ page }) => {
    await page.goto(`/w/${fx().workspaces.w1.id}`);
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("a members URL redirects to /sign-in", async ({ page }) => {
    await page.goto(`/w/${fx().workspaces.w1.id}/members`);
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});

test.describe("alice (Owner of W1, Viewer of W2)", () => {
  test.use({ storageState: storageStatePath("alice") });

  test("AC-08: / opens her first workspace and the sidebar lists exactly W1 and W2", async ({ page }) => {
    const { workspaces } = fx();
    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`/w/${workspaces.w1.id}$`));
    await expect(page.getByTestId("signed-in-as")).toHaveText("alice@allowed.test");
    await expect(page.getByTestId("workspace-name")).toHaveText([workspaces.w1.name, workspaces.w2.name]);
    await expect(page.getByText(workspaces.w3.name)).toHaveCount(0);
  });

  test("AC-13 / TC-11: switching W1 → W2 → W1 shows only that workspace's pages", async ({ page }) => {
    const { workspaces, pages } = fx();
    const titles = (key: "w1" | "w2") => pages[key].map((p) => p.title).sort();
    const shownTitles = async () => (await page.getByTestId("page-item").allTextContents()).sort();

    await page.goto(`/w/${workspaces.w1.id}`);
    await expect(page.getByTestId("workspace-title")).toHaveText(workspaces.w1.name);
    await expect(page.getByTestId("page-item")).toHaveCount(pages.w1.length);
    expect(await shownTitles()).toEqual(titles("w1"));

    await page.getByRole("link", { name: workspaces.w2.name }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${workspaces.w2.id}$`));
    await expect(page.getByTestId("workspace-title")).toHaveText(workspaces.w2.name);
    await expect(page.getByTestId("page-item")).toHaveCount(pages.w2.length);
    expect(await shownTitles()).toEqual(titles("w2"));

    await page.getByRole("link", { name: workspaces.w1.name }).click();
    await expect(page.getByTestId("workspace-title")).toHaveText(workspaces.w1.name);
    await expect(page.getByTestId("page-item")).toHaveCount(pages.w1.length);
    expect(await shownTitles()).toEqual(titles("w1"));
  });

  test("AC-37 / AC-18: member controls in W1 (Owner), none in W2 (Viewer), W1 → W2 → W1", async ({ page }) => {
    const { workspaces } = fx();

    await page.goto(`/w/${workspaces.w1.id}/members`);
    await expect(page.getByTestId("member-row")).toHaveCount(3);
    await expect(main(page).getByTestId("add-member-form")).toBeVisible();
    await expect(main(page).getByRole("button", { name: "Save role" })).toHaveCount(3);
    await expect(main(page).getByRole("button", { name: "Remove" })).toHaveCount(3);

    await page.goto(`/w/${workspaces.w2.id}/members`);
    await expect(page.getByTestId("member-row")).toHaveCount(2);
    await expectNoMemberControls(page);

    await page.goto(`/w/${workspaces.w1.id}/members`);
    await expect(main(page).getByTestId("add-member-form")).toBeVisible();

    await page.goto(`/w/${workspaces.w2.id}`);
    await expect(page.getByTestId("my-role")).toHaveText("Your role: Viewer");
  });
});

test.describe("carol (Viewer of W1)", () => {
  test.use({ storageState: storageStatePath("carol") });

  test("TC-18 / AC-18: the members and workspace views render no management controls", async ({ page }) => {
    const { workspaces } = fx();
    await page.goto(`/w/${workspaces.w1.id}/members`);
    await expect(page.getByTestId("member-row")).toHaveCount(3);
    await expect(page.getByTestId("member-email")).toHaveText(["alice@allowed.test", "bob@allowed.test", "carol@allowed.test"]);
    await expect(page.getByTestId("member-role")).toHaveText(["Owner", "Editor", "Viewer"]);
    await expectNoMemberControls(page);

    await page.goto(`/w/${workspaces.w1.id}`);
    await expect(page.getByTestId("my-role")).toHaveText("Your role: Viewer");
    await expectNoMemberControls(page);
  });

  test("TC-19 / AC-10: another workspace's URLs are a 404 without its data", async ({ page }) => {
    const { workspaces, pages } = fx();
    for (const path of [`/w/${workspaces.w2.id}`, `/w/${workspaces.w2.id}/members`]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
      const html = await page.content();
      expect(html).not.toContain(workspaces.w2.name);
      expect(html).not.toContain(pages.w2[0].title);
      expect(html).not.toContain("dave@allowed.test");
    }
  });

  test("an unknown or malformed workspace id is a 404", async ({ page }) => {
    expect((await page.goto("/w/00000000-0000-4000-8000-000000000000"))?.status()).toBe(404);
    expect((await page.goto("/w/not-a-uuid"))?.status()).toBe(404);
  });
});

test.describe("outsider (no memberships)", () => {
  test.use({ storageState: storageStatePath("outsider") });

  test("/ shows the empty state and an empty sidebar", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await expect(page.getByTestId("workspace-link")).toHaveCount(0);
  });
});

test.describe("erin (Owner of W3): real server actions", () => {
  test.use({ storageState: storageStatePath("erin") });
  test.describe.configure({ mode: "serial" });

  test("AC-09: whitespace-only name is rejected; a valid name creates a workspace she owns", async ({ page }) => {
    const { workspaces } = fx();
    await page.goto(`/w/${workspaces.w3.id}`);
    const form = page.getByRole("form", { name: "Create workspace" });

    await form.getByRole("textbox").fill("   ");
    await form.getByRole("button", { name: "Create workspace" }).click();
    await expect(form.getByRole("alert")).toHaveText("Workspace name is required.");
    await expect(page.getByTestId("workspace-link")).toHaveCount(1);

    await form.getByRole("textbox").fill("  E2E Created Space  ");
    await form.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("workspace-title")).toHaveText("E2E Created Space");
    await expect(page.getByTestId("my-role")).toHaveText("Your role: Owner");
    await expect(page.getByTestId("workspace-name")).toHaveText(["E2E Created Space", workspaces.w3.name]);
  });

  test("T-09: add (unknown email rejected), change role, then remove a member in W3", async ({ page }) => {
    const { workspaces } = fx();
    await page.goto(`/w/${workspaces.w3.id}/members`);
    await expect(page.getByTestId("member-row")).toHaveCount(1);
    const addForm = page.getByTestId("add-member-form");

    await addForm.getByLabel("Email").fill("nobody@allowed.test");
    await addForm.getByRole("button", { name: "Add member" }).click();
    await expect(addForm.getByRole("alert")).toContainText("has signed in yet");
    await expect(page.getByTestId("member-row")).toHaveCount(1);

    await addForm.getByLabel("Email").fill("outsider@allowed.test");
    await addForm.getByLabel("Role").selectOption("viewer");
    await addForm.getByRole("button", { name: "Add member" }).click();
    await expect(page.getByTestId("member-row")).toHaveCount(2);
    const outsiderRow = page.getByTestId("member-row").filter({ hasText: "outsider@allowed.test" });

    await outsiderRow.getByRole("combobox").selectOption("editor");
    const saved = page.waitForResponse(
      (response) => response.request().method() === "POST" && "next-action" in response.request().headers(),
    );
    await outsiderRow.getByRole("button", { name: "Save role" }).click();
    expect((await saved).status()).toBe(200);
    await page.reload();
    await expect(
      page.getByTestId("member-row").filter({ hasText: "outsider@allowed.test" }).getByRole("combobox"),
    ).toHaveValue("editor");

    await page.getByTestId("member-row").filter({ hasText: "outsider@allowed.test" }).getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("member-row")).toHaveCount(1);
  });

  test("AC-17: removing herself as the last Owner shows the conflict and keeps her", async ({ page }) => {
    const { workspaces } = fx();
    await page.goto(`/w/${workspaces.w3.id}/members`);
    const selfRow = page.getByTestId("member-row").filter({ hasText: "erin@allowed.test" });
    await selfRow.getByRole("button", { name: "Remove" }).click();
    await expect(selfRow.getByRole("alert")).toHaveText("A workspace must keep at least one Owner.");
    await page.reload();
    await expect(page.getByTestId("member-row")).toHaveCount(1);
  });
});
