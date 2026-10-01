import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { Fixtures } from "../support/fixtures";
import { FIXTURES_FILE, storageStatePath } from "./support/paths";

// Increment D E2E (MOCKED auth: sessions from the test-only helper, DP8; no
// real Google login). bob = Editor of W1, carol = Viewer of W1.
//
// TC-24 UI part (AC-19), TC-25 (AC-20), TC-26 (AC-27), TC-27 (AC-29),
// TC-28 (AC-30), TC-29 UI part (AC-28), TC-18 page view (AC-18).
// Every test deletes the pages it creates (and `afterEach` cleans up after a
// failure), so W1 is back to its fixtures for the other specs.

const fx = (): Fixtures => JSON.parse(readFileSync(FIXTURES_FILE, "utf8")) as Fixtures;

const stamp = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const editorBox = (page: Page) => page.getByRole("textbox", { name: "Page content" });

const toolbarButton = (page: Page, name: string) =>
  page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name, exact: true });

interface EditorJson {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: EditorJson[];
  marks?: Array<{ type: string }>;
  text?: string;
}

/** The editor's serialized document, read from the live Tiptap instance. */
async function editorJson(page: Page): Promise<EditorJson> {
  await expect(editorBox(page)).toBeVisible();
  return page.evaluate(() => {
    const element = document.querySelector('[aria-label="Page content"]') as
      | (HTMLElement & { editor?: { getJSON(): unknown } })
      | null;
    if (!element?.editor) throw new Error("editor is not mounted");
    return element.editor.getJSON() as EditorJson;
  });
}

function collect(node: EditorJson, out = { nodes: new Set<string>(), marks: new Set<string>(), headings: new Set<unknown>() }) {
  if (node.type) out.nodes.add(node.type);
  if (node.type === "heading") out.headings.add(node.attrs?.level);
  for (const mark of node.marks ?? []) out.marks.add(mark.type);
  for (const child of node.content ?? []) collect(child, out);
  return out;
}

/** Paths of pages created by the current test (cleaned up in afterEach). */
const createdPages: string[] = [];

/** bob creates a page from the workspace home and lands on it; returns its path. */
async function createPageViaUi(page: Page, workspaceId: string, title: string): Promise<string> {
  await page.goto(`/w/${workspaceId}`);
  const form = page.getByTestId("create-page-form");
  await form.getByRole("textbox").fill(title);
  await form.getByRole("button", { name: "Create page" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/p/[0-9a-f-]{36}$`));
  const path = new URL(page.url()).pathname;
  createdPages.push(path);
  await expect(editorBox(page)).toBeVisible();
  return path;
}

async function saveAndWait(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
}

async function deleteViaUi(page: Page, pagePath: string, workspaceId: string) {
  await page.goto(pagePath);
  await page.getByRole("button", { name: "Delete page" }).click();
  await page.getByTestId("delete-page-confirm").getByRole("button", { name: "Confirm delete" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}$`));
}

/** Cleanup after a failure: delete the page if it still exists (never throws). */
async function bestEffortDelete(page: Page, pagePath: string) {
  try {
    const response = await page.goto(pagePath);
    if (response?.status() !== 200) return;
    await page.getByRole("button", { name: "Delete page" }).click({ timeout: 10_000 });
    await page.getByRole("button", { name: "Confirm delete" }).click({ timeout: 10_000 });
    await page.waitForURL((url) => !url.pathname.includes("/p/"), { timeout: 10_000 });
  } catch {
    // The failing assertion is already reported.
  }
}

async function openAs(browser: Browser, user: string) {
  const context = await browser.newContext({ storageState: storageStatePath(user) });
  return { context, page: await context.newPage() };
}

function collectDialogs(page: Page): string[] {
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  return dialogs;
}

test.describe("pages: bob (Editor of W1) and carol (Viewer of W1)", () => {
  test.use({ storageState: storageStatePath("bob") });
  test.describe.configure({ mode: "serial" });

  test.afterEach(async ({ page }) => {
    // No-op when the test already deleted its pages (they answer 404).
    while (createdPages.length > 0) {
      await bestEffortDelete(page, createdPages.pop() as string);
    }
  });

  test("AC-19/27/29/18/28: create, format, save, reload; Viewer is read-only; delete → 404", async ({ page, browser }) => {
    test.setTimeout(180_000);
    const { workspaces } = fx();
    const w1 = workspaces.w1.id;
    const title = `E2E formatted ${stamp()}`;

    // AC-19: bob creates the page from the workspace home.
    const pagePath = await createPageViaUi(page, w1, title);
    await expect(page.getByLabel("Page title")).toHaveValue(title);

    // Format with the toolbar: H1–H3, bold, italic, bullet and numbered lists.
    await editorBox(page).click();
    await toolbarButton(page, "Heading 1").click();
    await page.keyboard.type("Heading one");
    await page.keyboard.press("Enter");
    await toolbarButton(page, "Heading 2").click();
    await page.keyboard.type("Heading two");
    await page.keyboard.press("Enter");
    await toolbarButton(page, "Heading 3").click();
    await page.keyboard.type("Heading three");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Plain ");
    await toolbarButton(page, "Bold").click();
    await page.keyboard.type("bold");
    await toolbarButton(page, "Bold").click();
    await page.keyboard.type(" and ");
    await toolbarButton(page, "Italic").click();
    await page.keyboard.type("italic");
    await toolbarButton(page, "Italic").click();
    await page.keyboard.press("Enter");
    await toolbarButton(page, "Bullet list").click();
    await page.keyboard.type("bullet one");
    await page.keyboard.press("Enter");
    await page.keyboard.type("bullet two");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await toolbarButton(page, "Numbered list").click();
    await page.keyboard.type("number one");
    await page.keyboard.press("Enter");
    await page.keyboard.type("number two");

    // AC-27: edit the title too.
    const editedTitle = `${title} (edited)`;
    await page.getByLabel("Page title").fill(editedTitle);
    await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");

    const beforeSave = await editorJson(page);
    const used = collect(beforeSave);
    expect([...used.headings].sort()).toEqual([1, 2, 3]);
    expect([...used.marks].sort()).toEqual(["bold", "italic"]);
    expect(used.nodes).toContain("bulletList");
    expect(used.nodes).toContain("orderedList");

    await saveAndWait(page);

    // AC-29: after a reload the serialized document deep-equals the one saved.
    await page.reload();
    const afterReload = await editorJson(page);
    expect(afterReload).toEqual(beforeSave);
    await expect(page.getByLabel("Page title")).toHaveValue(editedTitle);
    const content = editorBox(page);
    await expect(content.locator("h1")).toHaveText("Heading one");
    await expect(content.locator("h2")).toHaveText("Heading two");
    await expect(content.locator("h3")).toHaveText("Heading three");
    await expect(content.locator("strong")).toHaveText("bold");
    await expect(content.locator("em")).toHaveText("italic");
    await expect(content.locator("ul > li")).toHaveText(["bullet one", "bullet two"]);
    await expect(content.locator("ol > li")).toHaveText(["number one", "number two"]);

    // AC-19: listed in W1 under the new title.
    await page.goto(`/w/${w1}`);
    await expect(page.getByTestId("page-item").filter({ hasText: editedTitle })).toHaveCount(1);

    // AC-20 / AC-18: carol (Viewer) sees the page read-only, without controls.
    const carol = await openAs(browser, "carol");
    try {
      await carol.page.goto(`/w/${w1}`);
      await expect(carol.page.getByTestId("page-item").filter({ hasText: editedTitle })).toHaveCount(1);
      await expect(carol.page.getByTestId("create-page-form")).toHaveCount(0);

      await carol.page.goto(pagePath);
      await expect(carol.page.getByTestId("page-title")).toHaveText(editedTitle);
      await expect(editorBox(carol.page)).toHaveAttribute("contenteditable", "false");
      await expect(editorBox(carol.page)).toHaveAttribute("aria-readonly", "true");
      expect(await editorJson(carol.page)).toEqual(beforeSave);
      await expect(carol.page.getByLabel("Page title")).toHaveCount(0);
      await expect(carol.page.getByRole("toolbar")).toHaveCount(0);
      await expect(carol.page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
      await expect(carol.page.getByRole("button", { name: "Delete page" })).toHaveCount(0);
      await expect(carol.page.locator("main").getByRole("button")).toHaveCount(0);

      // T-12: the delete needs a confirm step (Cancel keeps the page).
      await page.goto(pagePath);
      await page.getByRole("button", { name: "Delete page" }).click();
      await page.getByTestId("delete-page-confirm").getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByTestId("delete-page-confirm")).toHaveCount(0);
      await expect(page.getByLabel("Page title")).toHaveValue(editedTitle);

      // AC-28: bob deletes; afterwards the page is a 404 for everyone.
      await deleteViaUi(page, pagePath, w1);
      await expect(page.getByTestId("page-item").filter({ hasText: editedTitle })).toHaveCount(0);
      expect((await page.goto(pagePath))?.status()).toBe(404);
      expect((await carol.page.goto(pagePath))?.status()).toBe(404);
    } finally {
      await carol.context.close();
    }
  });

  test("AC-30: <script> and onerror= payloads typed as text never execute", async ({ page, browser }) => {
    test.setTimeout(180_000);
    const { workspaces } = fx();
    const w1 = workspaces.w1.id;
    const dialogs = collectDialogs(page);

    const titlePayload = `<img src=x onerror="window.__xss=1;alert('title')"> ${stamp()}`;
    const scriptPayload = "<script>window.__xss=1;alert('script')</script>";
    const onerrorPayload = '<img src=x onerror="window.__xss=1;alert(\'onerror\')">';

    const assertInert = async (viewer: Page, viewerDialogs: string[]) => {
      await expect(editorBox(viewer)).toBeVisible();
      await expect(editorBox(viewer).locator("p")).toHaveText([scriptPayload, onerrorPayload]);
      await expect(editorBox(viewer).locator("script, img, svg, iframe")).toHaveCount(0);
      expect(await viewer.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
      expect(viewerDialogs).toEqual([]);
    };

    const pagePath = await createPageViaUi(page, w1, titlePayload);
    await editorBox(page).click();
    await page.keyboard.type(scriptPayload);
    await page.keyboard.press("Enter");
    await page.keyboard.type(onerrorPayload);
    await saveAndWait(page);

    await page.reload();
    await assertInert(page, dialogs);
    await expect(page.getByLabel("Page title")).toHaveValue(titlePayload);

    // The page list renders the title as text too.
    await page.goto(`/w/${w1}`);
    await expect(page.getByTestId("page-item").filter({ hasText: titlePayload })).toHaveCount(1);
    await expect(page.getByTestId("page-list").locator("img")).toHaveCount(0);
    expect(dialogs).toEqual([]);

    // Read-only rendering for a Viewer is inert as well.
    const carol = await openAs(browser, "carol");
    try {
      const carolDialogs = collectDialogs(carol.page);
      await carol.page.goto(pagePath);
      await assertInert(carol.page, carolDialogs);
      await expect(carol.page.getByTestId("page-title")).toHaveText(titlePayload);
    } finally {
      await carol.context.close();
    }

    await deleteViaUi(page, pagePath, w1);
    expect((await page.goto(pagePath))?.status()).toBe(404);
    expect(dialogs).toEqual([]);
  });
});
