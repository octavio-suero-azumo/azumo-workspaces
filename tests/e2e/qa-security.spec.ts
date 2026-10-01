import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import type { Fixtures } from "../support/fixtures";
import { FIXTURES_FILE, storageStatePath } from "./support/paths";

// ============================================================================
// QA independent verification (T-17a / T-17b), E2E level.
// Auth mode: SIMULATED (test-only sessions, DP8). No real Google login.
//
// Gaps closed (not covered by the developer's specs):
// 1. Forged session cookie on EVERY app route (the proxy lets any cookie
//    through; only `/` was checked before).
// 2. Server actions over real HTTP: a legitimate user's server-action POST is
//    captured in the browser (and aborted, so it never runs), then replayed by
//    other callers — no session, a forged cookie, a Viewer, an Editor, a
//    non-member — and with another workspace's ids substituted into the
//    payload (AC-38). The DB is then checked through the UI of an authorized
//    user. This is "hidden button ≠ authorization" end to end.
// 3. URL id substitution for pages (/w/{W1}/p/{W2 page}).
// 4. AC-37 / AC-18 on the page view (alice Owner W1 / Viewer W2, W1→W2→W1)
//    and member controls for an Editor.
//
// Side effects: none on success. Every captured request is aborted; every
// replay must be denied. The one positive control creates a page and deletes
// it again.
// ============================================================================

const fx = (): Fixtures => JSON.parse(readFileSync(FIXTURES_FILE, "utf8")) as Fixtures;

const FORGED_COOKIE = "better-auth.session_token=forged-token.forged-signature";

const stamp = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

type Caller = "none" | "forged" | "alice" | "bob" | "carol" | "outsider" | "erin";
type Expected = "PROXY_REDIRECT" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND";

interface CapturedAction {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** Strings from the fixtures that a denial must never echo back. */
function fixtureStrings(f: Fixtures): string[] {
  return [
    ...Object.values(f.workspaces).map((w) => w.name),
    ...Object.values(f.pages).flatMap((list) => list.map((p) => p.title)),
    ...Object.values(f.attachments).flatMap((a) => [a.displayName, a.blobPathname]),
    "dave@allowed.test",
  ];
}

/**
 * Run `trigger` in the browser, capture the server-action POST it produces and
 * ABORT it (the legitimate user's request never reaches the server).
 */
async function captureServerAction(page: Page, trigger: () => Promise<void>): Promise<CapturedAction> {
  let captured: CapturedAction | undefined;
  const matcher = (url: URL) => url.pathname === "/" || url.pathname.startsWith("/w/");
  await page.route(matcher, async (route) => {
    const request = route.request();
    const headers = request.headers();
    if (request.method() === "POST" && headers["next-action"]) {
      captured = { url: request.url(), headers, body: request.postDataBuffer() ?? Buffer.alloc(0) };
      await route.abort();
      return;
    }
    await route.continue();
  });
  await trigger();
  await expect.poll(() => captured !== undefined, { timeout: 15_000 }).toBe(true);
  await page.unroute(matcher);
  expect(captured!.body.length).toBeGreaterThan(0);
  return captured!;
}

/** Same request with every occurrence of `from` replaced by `to` (same-length UUIDs). */
function substitute(action: CapturedAction, replacements: ReadonlyArray<readonly [string, string]>): CapturedAction {
  let body = action.body.toString("utf8");
  for (const [from, to] of replacements) {
    expect(body).toContain(from);
    body = body.split(from).join(to);
  }
  return { ...action, body: Buffer.from(body, "utf8") };
}

/**
 * An HTTP client for `who`. NOTE: `playwright.request.newContext()` inherits the
 * test-level `use({ storageState })` unless one is passed explicitly (found
 * during this QA run: an "anonymous" context silently carried the signed-in
 * user's cookie). So every context pins its storage state, and the resulting
 * cookie jar is asserted before any replay.
 */
async function requestContext(
  playwright: PlaywrightWorkerArgs["playwright"],
  baseURL: string,
  who: Caller,
): Promise<APIRequestContext> {
  const EMPTY = { cookies: [], origins: [] };
  const ctx =
    who === "none"
      ? await playwright.request.newContext({ baseURL, storageState: EMPTY })
      : who === "forged"
        ? await playwright.request.newContext({ baseURL, storageState: EMPTY, extraHTTPHeaders: { cookie: FORGED_COOKIE } })
        : await playwright.request.newContext({ baseURL, storageState: storageStatePath(who) });
  const jar = (await ctx.storageState()).cookies;
  if (who === "none" || who === "forged") {
    expect(jar, `${who} context must carry no stored cookie`).toEqual([]);
  } else {
    const expected = JSON.parse(readFileSync(storageStatePath(who), "utf8")) as { cookies: Array<{ value: string }> };
    expect(jar.map((c) => c.value), `${who} context must carry exactly ${who}'s session`).toEqual(
      expected.cookies.map((c) => c.value),
    );
  }
  return ctx;
}

const REPLAYED_HEADERS = new Set(["next-action", "next-router-state-tree", "content-type", "accept"]);

async function replay(ctx: APIRequestContext, action: CapturedAction, baseURL: string) {
  const headers: Record<string, string> = { origin: baseURL };
  for (const [name, value] of Object.entries(action.headers)) {
    if (REPLAYED_HEADERS.has(name)) headers[name] = value;
  }
  const response = await ctx.post(action.url, { headers, data: action.body, maxRedirects: 0 });
  return { status: response.status(), location: response.headers()["location"] ?? null, text: await response.text() };
}

/** Replay `action` as each caller and check each is denied the expected way, with no fixture data echoed. */
async function expectReplaysDenied(
  playwright: PlaywrightWorkerArgs["playwright"],
  baseURL: string,
  action: CapturedAction,
  cases: ReadonlyArray<readonly [Caller, Expected]>,
) {
  const f = fx();
  for (const [who, expected] of cases) {
    const ctx = await requestContext(playwright, baseURL, who);
    try {
      const result = await replay(ctx, action, baseURL);
      const label = `${who} → ${expected} (got ${result.status}: ${result.text.slice(0, 200)})`;
      if (expected === "PROXY_REDIRECT") {
        expect([307, 308], label).toContain(result.status);
        expect(new URL(result.location ?? "", baseURL).pathname, label).toBe("/sign-in");
      } else {
        expect(result.status, label).toBe(200);
        expect(result.text, label).toContain(`"code":"${expected}"`);
        expect(result.text, label).not.toContain('"ok":true');
      }
      for (const value of fixtureStrings(f)) expect(result.text, `${label} leaks ${value}`).not.toContain(value);
    } finally {
      await ctx.dispose();
    }
  }
}

const NO_SESSION: ReadonlyArray<readonly [Caller, Expected]> = [
  ["none", "PROXY_REDIRECT"],
  ["forged", "UNAUTHENTICATED"],
];

// ---------------------------------------------------------------------------
// 1. No valid session on every app route (essential check 2).
// ---------------------------------------------------------------------------

test.describe("QA: no valid session on every app route", () => {
  const inventory = (f: Fixtures) => [
    "/",
    `/w/${f.workspaces.w1.id}`,
    `/w/${f.workspaces.w1.id}/members`,
    `/w/${f.workspaces.w1.id}/p/${f.pages.w1[0].id}`,
  ];

  test("without a cookie every route ends on /sign-in and shows no workspace data", async ({ page }) => {
    const f = fx();
    for (const path of inventory(f)) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/sign-in$/);
      const html = await page.content();
      for (const value of fixtureStrings(f)) expect(html, `${path} leaks ${value}`).not.toContain(value);
    }
  });

  test("with a forged cookie (passes the proxy) every route still ends on /sign-in with no workspace data", async ({
    page,
    context,
    baseURL,
  }) => {
    const f = fx();
    await context.addCookies([{ name: "better-auth.session_token", value: "forged-token.forged-signature", url: baseURL! }]);
    for (const path of inventory(f)) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/sign-in$/);
      const html = await page.content();
      for (const value of fixtureStrings(f)) expect(html, `${path} leaks ${value}`).not.toContain(value);
    }
  });

  test("raw HTTP with a forged cookie: no route answers with workspace data", async ({ request }) => {
    const f = fx();
    for (const path of inventory(f)) {
      const response = await request.get(path, { headers: { cookie: FORGED_COOKIE }, maxRedirects: 0 });
      const body = await response.text();
      for (const value of fixtureStrings(f)) expect(body, `${path} leaks ${value}`).not.toContain(value);
      if (response.status() >= 300 && response.status() < 400) {
        expect(new URL(response.headers()["location"] ?? "", "http://x").pathname, path).toBe("/sign-in");
      } else {
        // Streaming responses signal the redirect in the payload instead.
        expect(body, path).toMatch(/NEXT_REDIRECT[^"]*\/sign-in/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Server actions replayed over real HTTP (essential checks 2, 5, 6).
// ---------------------------------------------------------------------------

test.describe("QA: page server actions captured from bob (Editor of W1) and replayed by others", () => {
  test.use({ storageState: storageStatePath("bob") });
  test.describe.configure({ mode: "serial" });

  test("createPageAction: denied for no/forged session, Viewer, non-members, and W2 substitution; nothing created", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const f = fx();
    const title = `QA forged page ${stamp()}`;
    await page.goto(`/w/${f.workspaces.w1.id}`);
    const action = await captureServerAction(page, async () => {
      const form = page.getByTestId("create-page-form");
      await form.getByRole("textbox").fill(title);
      await form.getByRole("button", { name: "Create page" }).click();
    });

    await expectReplaysDenied(playwright, baseURL!, action, [
      ...NO_SESSION,
      ["carol", "FORBIDDEN"],
      ["outsider", "NOT_FOUND"],
      ["erin", "NOT_FOUND"],
    ]);
    // AC-38: the same payload aimed at W2.
    const toW2 = substitute(action, [[f.workspaces.w1.id, f.workspaces.w2.id]]);
    await expectReplaysDenied(playwright, baseURL!, toW2, [
      ["alice", "FORBIDDEN"],
      ["bob", "NOT_FOUND"],
      ["carol", "NOT_FOUND"],
    ]);

    await page.goto(`/w/${f.workspaces.w1.id}`);
    await expect(page.getByTestId("page-item").filter({ hasText: title })).toHaveCount(0);
    const alice = await page.context().browser()!.newContext({ storageState: storageStatePath("alice") });
    try {
      const alicePage = await alice.newPage();
      await alicePage.goto(`/w/${f.workspaces.w2.id}`);
      await expect(alicePage.getByTestId("page-item")).toHaveText(f.pages.w2.map((p) => p.title));
    } finally {
      await alice.close();
    }
  });

  test("control: the same replay mechanism works for an allowed caller (bob), then the page is removed", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const f = fx();
    const title = `QA control page ${stamp()}`;
    await page.goto(`/w/${f.workspaces.w1.id}`);
    const action = await captureServerAction(page, async () => {
      const form = page.getByTestId("create-page-form");
      await form.getByRole("textbox").fill(title);
      await form.getByRole("button", { name: "Create page" }).click();
    });

    const ctx = await requestContext(playwright, baseURL!, "bob");
    try {
      const result = await replay(ctx, action, baseURL!);
      for (const code of ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "VALIDATION", "INTERNAL"]) {
        expect(result.text).not.toContain(`"code":"${code}"`);
      }
    } finally {
      await ctx.dispose();
    }

    await page.goto(`/w/${f.workspaces.w1.id}`);
    const item = page.getByTestId("page-item").filter({ hasText: title });
    await expect(item).toHaveCount(1);
    // Clean up through the UI.
    await item.getByRole("link").click();
    await page.getByRole("button", { name: "Delete page" }).click();
    await page.getByTestId("delete-page-confirm").getByRole("button", { name: "Confirm delete" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${f.workspaces.w1.id}$`));
    await expect(page.getByTestId("page-item").filter({ hasText: title })).toHaveCount(0);
  });

  test("savePageAction: denied for no/forged session, Viewer, non-members, and a W2 page id; titles unchanged", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const f = fx();
    const target = f.pages.w1[0];
    await page.goto(`/w/${f.workspaces.w1.id}/p/${target.id}`);
    const action = await captureServerAction(page, async () => {
      await page.getByLabel("Page title").fill(`QA hijacked ${stamp()}`);
      await page.getByRole("button", { name: "Save", exact: true }).click();
    });

    await expectReplaysDenied(playwright, baseURL!, action, [
      ...NO_SESSION,
      ["carol", "FORBIDDEN"],
      ["outsider", "NOT_FOUND"],
      ["erin", "NOT_FOUND"],
    ]);
    // AC-38: a W2 page id with the W1 route context still in the payload.
    const w2Page = substitute(action, [[target.id, f.pages.w2[0].id]]);
    await expectReplaysDenied(playwright, baseURL!, w2Page, [
      ["alice", "FORBIDDEN"],
      ["bob", "NOT_FOUND"],
    ]);

    await page.goto(`/w/${f.workspaces.w1.id}/p/${target.id}`);
    await expect(page.getByLabel("Page title")).toHaveValue(target.title);
    const alice = await page.context().browser()!.newContext({ storageState: storageStatePath("alice") });
    try {
      const alicePage = await alice.newPage();
      await alicePage.goto(`/w/${f.workspaces.w2.id}/p/${f.pages.w2[0].id}`);
      await expect(alicePage.getByTestId("page-title")).toHaveText(f.pages.w2[0].title);
    } finally {
      await alice.close();
    }
  });

  test("deletePageAction: denied for no/forged session, Viewer, non-members, and a W2 page id; pages still exist", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const f = fx();
    const target = f.pages.w1[1];
    await page.goto(`/w/${f.workspaces.w1.id}/p/${target.id}`);
    const action = await captureServerAction(page, async () => {
      await page.getByRole("button", { name: "Delete page" }).click();
      await page.getByTestId("delete-page-confirm").getByRole("button", { name: "Confirm delete" }).click();
    });

    await expectReplaysDenied(playwright, baseURL!, action, [
      ...NO_SESSION,
      ["carol", "FORBIDDEN"],
      ["outsider", "NOT_FOUND"],
      ["erin", "NOT_FOUND"],
    ]);
    const w2Page = substitute(action, [[target.id, f.pages.w2[0].id]]);
    await expectReplaysDenied(playwright, baseURL!, w2Page, [
      ["alice", "FORBIDDEN"],
      ["bob", "NOT_FOUND"],
    ]);

    expect((await page.goto(`/w/${f.workspaces.w1.id}/p/${target.id}`))?.status()).toBe(200);
    await expect(page.getByLabel("Page title")).toHaveValue(target.title);
    const alice = await page.context().browser()!.newContext({ storageState: storageStatePath("alice") });
    try {
      const alicePage = await alice.newPage();
      expect((await alicePage.goto(`/w/${f.workspaces.w2.id}/p/${f.pages.w2[0].id}`))?.status()).toBe(200);
    } finally {
      await alice.close();
    }
  });

  test("deleteAttachmentAction: denied for no/forged session, Viewer, non-members, and W2's attachment id; files kept", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const f = fx();
    const pagePath = `/w/${f.workspaces.w1.id}/p/${f.pages.w1[0].id}`;
    await page.goto(pagePath);
    const action = await captureServerAction(page, async () => {
      await page.getByRole("button", { name: `Delete file ${f.attachments.w1.displayName}` }).click();
      await page.getByTestId("delete-attachment-confirm").getByRole("button", { name: "Yes, delete file" }).click();
    });

    await expectReplaysDenied(playwright, baseURL!, action, [
      ...NO_SESSION,
      ["carol", "FORBIDDEN"],
      ["outsider", "NOT_FOUND"],
      ["erin", "NOT_FOUND"],
    ]);
    const w2File = substitute(action, [[f.attachments.w1.id, f.attachments.w2.id]]);
    await expectReplaysDenied(playwright, baseURL!, w2File, [
      ["alice", "FORBIDDEN"],
      ["bob", "NOT_FOUND"],
      ["carol", "NOT_FOUND"],
    ]);

    await page.goto(pagePath);
    await expect(page.getByTestId("attachment-download")).toHaveText(f.attachments.w1.displayName);
    const alice = await page.context().browser()!.newContext({ storageState: storageStatePath("alice") });
    try {
      const alicePage = await alice.newPage();
      await alicePage.goto(`/w/${f.workspaces.w2.id}/p/${f.pages.w2[0].id}`);
      await expect(alicePage.getByTestId("attachment-download")).toHaveText(f.attachments.w2.displayName);
    } finally {
      await alice.close();
    }
  });

  test("createWorkspaceAction: denied without a valid session", async ({ page, playwright, baseURL }) => {
    const f = fx();
    await page.goto(`/w/${f.workspaces.w1.id}`);
    const action = await captureServerAction(page, async () => {
      const form = page.getByRole("form", { name: "Create workspace" });
      await form.getByRole("textbox").fill(`QA forged workspace ${stamp()}`);
      await form.getByRole("button", { name: "Create workspace" }).click();
    });
    await expectReplaysDenied(playwright, baseURL!, action, NO_SESSION);
  });
});

test.describe("QA: member server actions captured from alice (Owner of W1) and replayed by others", () => {
  test.use({ storageState: storageStatePath("alice") });
  test.describe.configure({ mode: "serial" });

  const membersPath = () => `/w/${fx().workspaces.w1.id}/members`;

  async function expectW1MembersUnchanged(page: Page) {
    await page.goto(membersPath());
    await expect(page.getByTestId("member-email")).toHaveText(["alice@allowed.test", "bob@allowed.test", "carol@allowed.test"]);
    const roles = page.getByTestId("member-role").getByRole("combobox");
    await expect(roles).toHaveCount(3);
    await expect(roles.nth(0)).toHaveValue("owner");
    await expect(roles.nth(1)).toHaveValue("editor");
    await expect(roles.nth(2)).toHaveValue("viewer");
  }

  async function expectW2MembersUnchanged(page: Page) {
    await page.goto(`/w/${fx().workspaces.w2.id}/members`);
    await expect(page.getByTestId("member-email")).toHaveText(["alice@allowed.test", "dave@allowed.test"]);
    await expect(page.getByTestId("member-role")).toHaveText(["Viewer", "Owner"]);
  }

  test("addMemberAction: denied for no/forged session, Viewer, Editor, non-members (incl. self-add), and W2; members unchanged", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const f = fx();
    await page.goto(membersPath());
    const action = await captureServerAction(page, async () => {
      const form = page.getByTestId("add-member-form");
      await form.getByLabel("Email").fill("outsider@allowed.test");
      await form.getByLabel("Role").selectOption("owner");
      await form.getByRole("button", { name: "Add member" }).click();
    });

    await expectReplaysDenied(playwright, baseURL!, action, [
      ...NO_SESSION,
      ["carol", "FORBIDDEN"],
      ["bob", "FORBIDDEN"],
      ["outsider", "NOT_FOUND"],
      ["erin", "NOT_FOUND"],
    ]);
    const toW2 = substitute(action, [[f.workspaces.w1.id, f.workspaces.w2.id]]);
    await expectReplaysDenied(playwright, baseURL!, toW2, [
      ["alice", "FORBIDDEN"],
      ["bob", "NOT_FOUND"],
      ["outsider", "NOT_FOUND"],
    ]);

    await expectW1MembersUnchanged(page);
    await expectW2MembersUnchanged(page);
  });

  test("changeMemberRoleAction (carol → owner): denied for carol herself, bob, no/forged session, non-members; roles unchanged", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const f = fx();
    await page.goto(membersPath());
    const action = await captureServerAction(page, async () => {
      const row = page.getByTestId("member-row").filter({ hasText: "carol@allowed.test" });
      await row.getByRole("combobox").selectOption("owner");
      await row.getByRole("button", { name: "Save role" }).click();
    });

    await expectReplaysDenied(playwright, baseURL!, action, [
      ...NO_SESSION,
      ["carol", "FORBIDDEN"],
      ["bob", "FORBIDDEN"],
      ["outsider", "NOT_FOUND"],
      ["erin", "NOT_FOUND"],
    ]);
    // AC-38: alice's own W2 membership id in the same payload → her W2 role (Viewer) applies.
    const w2Membership = substitute(action, [[f.memberships["carol:w1"], f.memberships["alice:w2"]]]);
    await expectReplaysDenied(playwright, baseURL!, w2Membership, [
      ["alice", "FORBIDDEN"],
      ["bob", "NOT_FOUND"],
    ]);

    await expectW1MembersUnchanged(page);
    await expectW2MembersUnchanged(page);
  });

  test("removeMemberAction (bob): denied for Viewer, Editor, no/forged session, non-members, and a W2 membership; members unchanged", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const f = fx();
    await page.goto(membersPath());
    const action = await captureServerAction(page, async () => {
      const row = page.getByTestId("member-row").filter({ hasText: "bob@allowed.test" });
      await row.getByRole("button", { name: "Remove" }).click();
    });

    await expectReplaysDenied(playwright, baseURL!, action, [
      ...NO_SESSION,
      ["carol", "FORBIDDEN"],
      ["bob", "FORBIDDEN"],
      ["outsider", "NOT_FOUND"],
      ["erin", "NOT_FOUND"],
    ]);
    const w2Membership = substitute(action, [[f.memberships["bob:w1"], f.memberships["dave:w2"]]]);
    await expectReplaysDenied(playwright, baseURL!, w2Membership, [
      ["alice", "FORBIDDEN"],
      ["bob", "NOT_FOUND"],
    ]);

    await expectW1MembersUnchanged(page);
    await expectW2MembersUnchanged(page);
  });
});

// ---------------------------------------------------------------------------
// 3. URL id substitution for pages, and 4. AC-37 / AC-18 on the page view.
// ---------------------------------------------------------------------------

test.describe("QA: alice (Owner of W1, Viewer of W2) — URL substitution and per-workspace controls", () => {
  test.use({ storageState: storageStatePath("alice") });

  test("AC-10/AC-38: a page is only reachable under its own workspace's URL", async ({ page }) => {
    const f = fx();
    for (const path of [
      `/w/${f.workspaces.w1.id}/p/${f.pages.w2[0].id}`,
      `/w/${f.workspaces.w2.id}/p/${f.pages.w1[0].id}`,
      `/w/${f.workspaces.w3.id}/p/${f.pages.w3[0].id}`,
      `/w/${f.workspaces.w1.id}/p/${f.pages.w3[0].id}`,
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      const html = await page.content();
      for (const value of [f.pages.w2[0].title, f.pages.w3[0].title, f.workspaces.w3.name, f.attachments.w2.displayName]) {
        expect(html, `${path} leaks ${value}`).not.toContain(value);
      }
    }
  });

  test("AC-37/AC-18: W1 page editable, W2 page read-only, W1 again editable (no carry-over)", async ({ page }) => {
    const f = fx();
    const w1Page = `/w/${f.workspaces.w1.id}/p/${f.pages.w1[0].id}`;
    const w2Page = `/w/${f.workspaces.w2.id}/p/${f.pages.w2[0].id}`;

    const expectOwnerControls = async () => {
      await page.goto(w1Page);
      await expect(page.getByLabel("Page title")).toHaveValue(f.pages.w1[0].title);
      await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Delete page" })).toBeVisible();
      await expect(page.getByTestId("upload-form")).toBeVisible();
      await page.goto(`/w/${f.workspaces.w1.id}`);
      await expect(page.getByTestId("create-page-form")).toBeVisible();
    };

    const expectViewerOnly = async () => {
      await page.goto(w2Page);
      await expect(page.getByTestId("page-title")).toHaveText(f.pages.w2[0].title);
      await expect(page.getByRole("textbox", { name: "Page content" })).toHaveAttribute("contenteditable", "false");
      await expect(page.getByLabel("Page title")).toHaveCount(0);
      await expect(page.getByRole("toolbar")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Delete page" })).toHaveCount(0);
      await expect(page.getByTestId("upload-form")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Delete file/ })).toHaveCount(0);
      await expect(page.getByTestId("attachment-download")).toHaveText(f.attachments.w2.displayName);
      await expect(page.locator("main").getByRole("button")).toHaveCount(0);
      await page.goto(`/w/${f.workspaces.w2.id}`);
      await expect(page.getByTestId("create-page-form")).toHaveCount(0);
      await expect(page.getByTestId("my-role")).toHaveText("Your role: Viewer");
    };

    await expectOwnerControls();
    await expectViewerOnly();
    await expectOwnerControls();
    await expectViewerOnly();
  });
});

test.describe("QA: bob (Editor of W1) — no member management controls, no access to W2 pages", () => {
  test.use({ storageState: storageStatePath("bob") });

  test("AC-18 (Editor): the member list is visible but has no add / change role / remove controls", async ({ page }) => {
    const f = fx();
    await page.goto(`/w/${f.workspaces.w1.id}/members`);
    await expect(page.getByTestId("member-row")).toHaveCount(3);
    await expect(page.getByTestId("member-role")).toHaveText(["Owner", "Editor", "Viewer"]);
    await expect(page.getByTestId("add-member-form")).toHaveCount(0);
    await expect(page.locator("main").getByRole("button", { name: "Save role" })).toHaveCount(0);
    await expect(page.locator("main").getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(page.locator("main").getByRole("combobox")).toHaveCount(0);
  });

  test("AC-10: W2 page URLs (own-workspace route or W1 route) are 404 without W2 data", async ({ page }) => {
    const f = fx();
    for (const path of [`/w/${f.workspaces.w2.id}/p/${f.pages.w2[0].id}`, `/w/${f.workspaces.w1.id}/p/${f.pages.w2[0].id}`]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      const html = await page.content();
      for (const value of [f.workspaces.w2.name, f.pages.w2[0].title, f.attachments.w2.displayName, "dave@allowed.test"]) {
        expect(html, `${path} leaks ${value}`).not.toContain(value);
      }
    }
  });
});
