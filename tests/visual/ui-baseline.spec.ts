import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test, type Browser, type BrowserContextOptions, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { Fixtures } from "../support/fixtures";
import { FIXTURES_FILE, storageStatePath } from "../e2e/support/paths";
import { auditPage, readActiveElement, type ActiveElementInfo } from "./support/ui-audit";

// ============================================================================
// UI BASELINE capture (QA, 2026-10-01). TEST-ONLY. Runs only after the
// isolation preflight passed (see playwright.visual.config.ts).
//
// - Data: the fictitious fixtures of the isolated in-memory PGlite (global
//   setup). The only writes are made here through the real UI on that
//   throwaway database: bob saves sample formatted content on W1's first page,
//   and erin creates one extra workspace and page (long-name stress evidence).
// - Auth: SIMULATED test-only sessions (DP8). No real Google login.
// - Uploads: not configured on purpose (empty Blob token), so the attachment
//   list shows the one fixture row and the upload form is disabled.
// - Screenshots: docs/evidence/ui/<VISUAL_PHASE>/<view>-<width>.png, full page,
//   light colour scheme, DPR 1, Next.js dev overlay hidden. An existing file is
//   never overwritten unless VISUAL_OVERWRITE=1.
// - Metrics (layout/overflow/contrast/focus/console): test-results/visual/metrics/.
// - Keyboard checks are non-destructive: confirm steps are only ever cancelled.
// ============================================================================

const REPO_ROOT = join(__dirname, "..", "..");
const PHASES = ["before", "after"] as const;
const phase = process.env.VISUAL_PHASE ?? "before";
if (!(PHASES as readonly string[]).includes(phase)) {
  throw new Error(`VISUAL_PHASE must be one of: ${PHASES.join(", ")}`);
}
const EVIDENCE_DIR = join(REPO_ROOT, "docs", "evidence", "ui", phase);
const OVERWRITE = process.env.VISUAL_OVERWRITE === "1";

/** Hides the Next.js dev-mode overlay (not product UI) in screenshots only. */
const SCREENSHOT_STYLE = "nextjs-portal { display: none !important; }";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  wide: { width: 1920, height: 1080 },
  mobile: { width: 390, height: 844 },
} as const;
type ViewportKind = keyof typeof VIEWPORTS;
type Who = "alice" | "bob" | "carol" | "erin" | null;

const fx = (): Fixtures => JSON.parse(readFileSync(FIXTURES_FILE, "utf8")) as Fixtures;

const w1PagePath = (f: Fixtures) => `/w/${f.workspaces.w1.id}/p/${f.pages.w1[0].id}`;

function contextOptions(kind: ViewportKind, who: Who, colorScheme: "light" | "dark" = "light"): BrowserContextOptions {
  return {
    // Always explicit, so no config-level default can leak in.
    storageState: who ? storageStatePath(who) : { cookies: [], origins: [] },
    viewport: { ...VIEWPORTS[kind] },
    deviceScaleFactor: 1,
    isMobile: kind === "mobile",
    hasTouch: kind === "mobile",
    colorScheme,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  };
}

/** Best effort: let hydration and late requests finish before measuring. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

const describeFocus = (info: ActiveElementInfo | null) => (info ? `${info.el} "${info.text}"` : "body (no focused element)");

/** Tab through the page from the top and record every stop and its focus indicator. */
async function focusAudit(page: Page, maxStops = 60) {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const stops: ActiveElementInfo[] = [];
  let devOverlayStops = 0;
  let endedBy = "max-stops";
  for (let i = 0; i < maxStops; i += 1) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(readActiveElement);
    if (info === null) {
      endedBy = "left-document";
      break;
    }
    if (info.devOverlay) {
      devOverlayStops += 1;
      continue;
    }
    if (info.seen) {
      endedBy = stops.length > 0 && stops[stops.length - 1].id === info.id ? `stuck on ${describeFocus(info)}` : "cycled";
      break;
    }
    stops.push(info);
  }
  return {
    endedBy,
    devOverlayStops,
    order: stops.map((stop) => `${stop.region}: ${stop.el} "${stop.text}"`),
    withoutIndicator: stops.filter((stop) => !stop.indicator).map((stop) => `${stop.region}: ${stop.el} "${stop.text}" (outline: ${stop.outline})`),
    notFocusVisible: stops.filter((stop) => !stop.focusVisible).map((stop) => `${stop.region}: ${stop.el} "${stop.text}"`),
    outOfViewport: stops.filter((stop) => !stop.inViewport).map((stop) => `${stop.region}: ${stop.el} "${stop.text}"`),
    firstStop: stops[0] ? `${stops[0].region}: ${stops[0].el} "${stops[0].text}"` : null,
    firstMainStopIndex: stops.findIndex((stop) => stop.region === "main"),
  };
}

/**
 * Keyboard behaviour of an inline confirm step: open with Enter, try Escape,
 * then CANCEL with Enter on the Cancel button (never the destructive button).
 */
async function inlineConfirmKeyboard(page: Page, trigger: Locator, confirm: Locator) {
  await trigger.focus();
  const triggerFocused = await page.evaluate(readActiveElement);
  await page.keyboard.press("Enter");
  await expect(confirm).toBeVisible();
  const afterOpen = await page.evaluate(readActiveElement);
  const confirmTag = await confirm.evaluate((el) => `${el.tagName.toLowerCase()}[role=${el.getAttribute("role") ?? "none"}]`);
  await page.keyboard.press("Escape");
  const openAfterEscape = await confirm.isVisible();
  let afterCancel: ActiveElementInfo | null = null;
  if (openAfterEscape) {
    const cancel = confirm.getByRole("button", { name: "Cancel", exact: true });
    await cancel.focus();
    const focused = await page.evaluate(readActiveElement);
    // Safety: Enter is pressed only when the focused element is the Cancel button.
    expect(focused?.text, "Enter is only pressed on Cancel").toBe("Cancel");
    await page.keyboard.press("Enter");
    await expect(confirm).toHaveCount(0);
    afterCancel = await page.evaluate(readActiveElement);
  }
  return {
    triggerFocused: describeFocus(triggerFocused),
    confirmElement: confirmTag,
    focusAfterOpen: describeFocus(afterOpen),
    escapeClosesConfirm: !openAfterEscape,
    focusAfterCancel: openAfterEscape ? describeFocus(afterCancel) : "n/a",
  };
}

interface ViewSpec {
  view: string;
  routePattern: string;
  route: string;
  who: Who;
  kind: ViewportKind;
  save: boolean;
  /** Not part of the requested baseline set (extra evidence). */
  extra?: boolean;
  colorScheme?: "light" | "dark";
  ready: (page: Page) => Promise<void>;
  keyboard?: (page: Page) => Promise<Record<string, unknown>>;
}

async function captureView(browser: Browser, testInfo: TestInfo, spec: ViewSpec) {
  const { width, height } = VIEWPORTS[spec.kind];
  const context = await browser.newContext(contextOptions(spec.kind, spec.who, spec.colorScheme));
  const consoleMessages: string[] = [];
  try {
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        consoleMessages.push(`${message.type()}: ${message.text().slice(0, 500)}`);
      }
    });
    page.on("pageerror", (error) => consoleMessages.push(`pageerror: ${error.message.slice(0, 500)}`));

    const response = await page.goto(spec.route);
    await spec.ready(page);
    await settle(page);
    const audit = await page.evaluate(auditPage);
    const aria = {
      aside: (await page.locator("aside").count()) > 0 ? await page.locator("aside").first().ariaSnapshot() : null,
      main: await page.locator("main").first().ariaSnapshot(),
    };

    let screenshot: string | null = null;
    if (spec.save) {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      const file = join(EVIDENCE_DIR, `${spec.view}-${width}.png`);
      if (existsSync(file) && !OVERWRITE) {
        throw new Error(`Refusing to overwrite ${relative(REPO_ROOT, file)} (set VISUAL_OVERWRITE=1 to replace evidence)`);
      }
      await page.screenshot({ path: file, fullPage: true, animations: "disabled", caret: "hide", style: SCREENSHOT_STYLE });
      screenshot = relative(REPO_ROOT, file);
    }

    // Keyboard checks run after the screenshot, so focus rings never appear in it.
    const keyboard = spec.keyboard ? await spec.keyboard(page) : null;
    const cookieNames = (await context.cookies()).map((cookie) => cookie.name).sort();

    const record = {
      phase,
      view: spec.view,
      extra: spec.extra ?? false,
      width,
      height,
      kind: spec.kind,
      who: spec.who,
      colorSchemeEmulated: spec.colorScheme ?? "light",
      routePattern: spec.routePattern,
      route: spec.route,
      status: response?.status() ?? null,
      finalPath: new URL(page.url()).pathname,
      screenshot,
      cookieNames,
      console: consoleMessages,
      audit,
      aria,
      keyboard,
    };
    const metricsDir = join(testInfo.project.outputDir, "metrics");
    mkdirSync(metricsDir, { recursive: true });
    const suffix = spec.colorScheme === "dark" ? "-dark-scheme" : "";
    writeFileSync(join(metricsDir, `${spec.view}-${width}${suffix}.json`), JSON.stringify(record, null, 2));
    return record;
  } finally {
    await context.close();
  }
}

const editorBox = (page: Page) => page.getByRole("textbox", { name: "Page content" });

/** Ready check for W1's first page after the setup content was saved. */
async function pageViewReady(page: Page, role: "editor" | "viewer") {
  const f = fx();
  await expect(editorBox(page)).toBeVisible();
  await expect(editorBox(page).locator("h1")).toHaveText("Q4 product roadmap");
  await expect(editorBox(page).locator("ul > li")).toHaveCount(3);
  await expect(editorBox(page).locator("ol > li")).toHaveCount(3);
  await expect(page.getByTestId("attachment-download")).toHaveText(f.attachments.w1.displayName);
  if (role === "editor") {
    await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
    await expect(page.getByLabel("Page title")).toHaveValue(f.pages.w1[0].title);
  } else {
    await expect(page.getByTestId("page-title")).toHaveText(f.pages.w1[0].title);
    await expect(editorBox(page)).toHaveAttribute("contenteditable", "false");
  }
}

function unbroken(seed: string, length: number): string {
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

test.describe.configure({ mode: "serial" });

test.describe("UI baseline (fictitious fixtures, simulated sessions, isolated PGlite)", () => {
  test.beforeEach(() => {
    test.setTimeout(300_000);
  });

  test("setup: bob (Editor) saves fictitious formatted content on W1's first page", async ({ browser }) => {
    const f = fx();
    const context = await browser.newContext(contextOptions("desktop", "bob"));
    try {
      const page = await context.newPage();
      await page.goto(w1PagePath(f));
      await expect(editorBox(page)).toBeVisible();
      const tool = (name: string) => page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name, exact: true });

      await editorBox(page).click();
      await tool("Heading 1").click();
      await page.keyboard.type("Q4 product roadmap");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Fictitious sample content for the UI baseline. Dates are ");
      await tool("Bold").click();
      await page.keyboard.type("tentative");
      await tool("Bold").click();
      await page.keyboard.type(" and are reviewed ");
      await tool("Italic").click();
      await page.keyboard.type("every Monday");
      await tool("Italic").click();
      await page.keyboard.type(".");
      await page.keyboard.press("Enter");
      await tool("Heading 2").click();
      await page.keyboard.type("Goals");
      await page.keyboard.press("Enter");
      await tool("Bullet list").click();
      await page.keyboard.type("Faster page loading");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Clearer member management");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Better file attachments");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await tool("Heading 3").click();
      await page.keyboard.type("Milestones");
      await page.keyboard.press("Enter");
      await tool("Numbered list").click();
      await page.keyboard.type("Design review");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Beta with the product team");
      await page.keyboard.press("Enter");
      await page.keyboard.type("General availability");

      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByTestId("save-status")).toHaveText("Saved");
      await page.reload();
      await pageViewReady(page, "editor");
      await expect(editorBox(page).locator("h2")).toHaveText("Goals");
      await expect(editorBox(page).locator("h3")).toHaveText("Milestones");
      await expect(editorBox(page).locator("strong")).toHaveText("tentative");
      await expect(editorBox(page).locator("em")).toHaveText("every Monday");
    } finally {
      await context.close();
    }
  });

  test("sign-in page (no session)", async ({ browser }, testInfo) => {
    const ready = async (page: Page) => {
      await expect(page.getByRole("heading", { name: "Sign in to Azumo Workspaces" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    };
    await captureView(browser, testInfo, {
      view: "sign-in",
      routePattern: "/sign-in",
      route: "/sign-in",
      who: null,
      kind: "desktop",
      save: true,
      ready,
      keyboard: async (page) => ({ focus: await focusAudit(page) }),
    });
    await captureView(browser, testInfo, {
      view: "sign-in",
      routePattern: "/sign-in",
      route: "/sign-in",
      who: null,
      kind: "mobile",
      save: true,
      extra: true,
      ready,
    });
  });

  test("workspace home as Owner (alice, W1)", async ({ browser }, testInfo) => {
    const f = fx();
    const route = `/w/${f.workspaces.w1.id}`;
    const ready = async (page: Page) => {
      await expect(page.getByTestId("workspace-title")).toHaveText(f.workspaces.w1.name);
      await expect(page.getByTestId("my-role")).toHaveText("Your role: Owner");
      await expect(page.getByTestId("page-item")).toHaveCount(f.pages.w1.length);
      await expect(page.getByTestId("create-page-form")).toBeVisible();
    };
    const base = { view: "workspace-home-owner", routePattern: "/w/{W1}", route, who: "alice" as const, ready };
    await captureView(browser, testInfo, {
      ...base,
      kind: "desktop",
      save: true,
      keyboard: async (page) => ({ focus: await focusAudit(page) }),
    });
    await captureView(browser, testInfo, { ...base, kind: "mobile", save: true });
    // Theme baseline: the system dark preference, no screenshot (metrics only).
    await captureView(browser, testInfo, { ...base, kind: "desktop", save: false, colorScheme: "dark" });
  });

  test("page view as Editor (bob, W1 first page: formatted content + attachment list)", async ({ browser }, testInfo) => {
    const f = fx();
    const base = {
      view: "page-view-editor",
      routePattern: "/w/{W1}/p/{W1 page 'W1 Roadmap'}",
      route: w1PagePath(f),
      who: "bob" as const,
      ready: (page: Page) => pageViewReady(page, "editor"),
    };
    await captureView(browser, testInfo, {
      ...base,
      kind: "desktop",
      save: true,
      keyboard: async (page) => ({
        focus: await focusAudit(page),
        deletePageConfirm: await inlineConfirmKeyboard(
          page,
          page.getByRole("button", { name: "Delete page" }),
          page.getByTestId("delete-page-confirm"),
        ),
        deleteAttachmentConfirm: await inlineConfirmKeyboard(
          page,
          page.getByRole("button", { name: `Delete file ${f.attachments.w1.displayName}` }),
          page.getByTestId("delete-attachment-confirm"),
        ),
      }),
    });
    await captureView(browser, testInfo, { ...base, kind: "wide", save: true });
    await captureView(browser, testInfo, { ...base, kind: "mobile", save: true });
  });

  test("page view as Viewer (carol, same page)", async ({ browser }, testInfo) => {
    const f = fx();
    const base = {
      view: "page-view-viewer",
      routePattern: "/w/{W1}/p/{W1 page 'W1 Roadmap'}",
      route: w1PagePath(f),
      who: "carol" as const,
      ready: (page: Page) => pageViewReady(page, "viewer"),
    };
    await captureView(browser, testInfo, {
      ...base,
      kind: "desktop",
      save: true,
      keyboard: async (page) => ({ focus: await focusAudit(page) }),
    });
    await captureView(browser, testInfo, { ...base, kind: "wide", save: true });
    await captureView(browser, testInfo, { ...base, kind: "mobile", save: true });
  });

  test("members page as Owner (alice, W1)", async ({ browser }, testInfo) => {
    const f = fx();
    const ready = async (page: Page) => {
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
      await expect(page.getByTestId("member-row")).toHaveCount(3);
      await expect(page.getByTestId("add-member-form")).toBeVisible();
    };
    const base = { view: "members-owner", routePattern: "/w/{W1}/members", route: `/w/${f.workspaces.w1.id}/members`, who: "alice" as const, ready };
    await captureView(browser, testInfo, {
      ...base,
      kind: "desktop",
      save: true,
      keyboard: async (page) => ({ focus: await focusAudit(page) }),
    });
    await captureView(browser, testInfo, { ...base, kind: "mobile", save: true, extra: true });
  });

  test("extra stress evidence: unbroken 100-char workspace name and 200-char page title (erin, new workspace only)", async ({
    browser,
  }, testInfo) => {
    const f = fx();
    // No spaces and no hyphens: browsers may break lines after a hyphen, so a
    // hyphenated name is not a worst case (first run: it wrapped normally).
    const workspaceName = unbroken("QuarterlyPlanningAndCrossTeamCoordination", 100);
    const pageTitle = unbroken("MeetingNotesForTheProductAndDesignReview", 200);
    let workspacePath = "";
    let pagePath = "";

    // Created through the real UI as erin (Owner of W3); no other fixture user is a member.
    const context = await browser.newContext(contextOptions("desktop", "erin"));
    try {
      const page = await context.newPage();
      await page.goto(`/w/${f.workspaces.w3.id}`);
      const workspaceForm = page.getByRole("form", { name: "Create workspace" });
      await workspaceForm.getByRole("textbox").fill(workspaceName);
      await workspaceForm.getByRole("button", { name: "Create workspace" }).click();
      await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}$/);
      await expect(page.getByTestId("workspace-title")).toHaveText(workspaceName);
      workspacePath = new URL(page.url()).pathname;

      const pageForm = page.getByTestId("create-page-form");
      await pageForm.getByRole("textbox").fill(pageTitle);
      await pageForm.getByRole("button", { name: "Create page" }).click();
      await expect(page).toHaveURL(/\/p\/[0-9a-f-]{36}$/);
      pagePath = new URL(page.url()).pathname;
    } finally {
      await context.close();
    }

    const homeReady = async (page: Page) => {
      await expect(page.getByTestId("workspace-title")).toHaveText(workspaceName);
      await expect(page.getByTestId("page-item")).toHaveText([pageTitle]);
    };
    const pageReady = async (page: Page) => {
      await expect(editorBox(page)).toBeVisible();
      await expect(page.getByLabel("Page title")).toHaveValue(pageTitle);
    };
    for (const kind of ["desktop", "mobile"] as const) {
      await captureView(browser, testInfo, {
        view: "workspace-home-long-names",
        routePattern: "/w/{erin's new workspace}",
        route: workspacePath,
        who: "erin",
        kind,
        save: true,
        extra: true,
        ready: homeReady,
      });
      await captureView(browser, testInfo, {
        view: "page-view-long-names",
        routePattern: "/w/{erin's new workspace}/p/{new page}",
        route: pagePath,
        who: "erin",
        kind,
        save: true,
        extra: true,
        ready: pageReady,
      });
    }
  });
});
