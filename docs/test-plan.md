# Test Plan: Azumo Workspaces (first iteration)

- **Status:** APPROVED (2026-09-29). Link cases TC-30–TC-32 are N/A (P2 = uploads). Test writing and execution were authorized with the implementation (2026-09-29). Results are recorded in `docs/status.md` and in the bench-mcp run reports.
- **Origin:** drafted by `qa` (real invocation, agentId `a78afac0e6e2a6e3b`) on 2026-09-29. The coordinator then applied the reviewer (agentId `a945a6d5953ce518b`) and developer observations. Every change is listed in §11.
- **Sources:** `docs/brief.md`, `docs/PRD.md`, `docs/architecture.md` (§5–§8), `docs/implementation-plan.md`, `docs/research.md` §8.
- **Dependency rule:** a case that depends on an unapproved PR*/DP* item or an open P* item stays conditional until the user resolves that item. This plan resolves nothing.

## 1. Strategy and levels

| Level | Tool (proposed, P3) | Scope |
|---|---|---|
| Unit (U) | Vitest | `env.ts`, the defensive domain check, `can()` matrix, URL validation, test-auth guard |
| Integration (I) | Vitest against the test DB | `authorize()`, data-layer scoping, DB constraints, server actions and route handlers called directly without the UI |
| E2E | Playwright with test-only sessions (DP8) | Redirects, UI visibility, persistence across reloads, multi-workspace flows |
| Manual (Man) | Browser plus Vercel/DB consoles | Real Google SSO, production checks, real Blob |

Authorization is always tested with **direct server calls** (I), because hidden UI proves nothing (R3.4).

## 2. Environments and fixtures

- **Test env:** a separate Postgres (local, or a Neon test branch). Never the production DB. `ENABLE_TEST_AUTH=1`. `ALLOWED_GOOGLE_HD` is set to a placeholder test domain such as `allowed.test`, so tests do not depend on P1 and contain no Azumo domain literal.
- **Fixture users** (created through `testUtils` or seed code only, all on fictional domains):

| Fixture | W1 | W2 | W3 |
|---|---|---|---|
| `alice` | Owner | **Viewer** | — |
| `bob` | Editor | — | — |
| `carol` | Viewer | — | — |
| `dave` | — | Owner | — |
| `erin` | — | — | Owner |
| `outsider` | — | — | — |

  Each workspace has at least one page, and one attachment when P2 allows it.
- **Per-test isolation:** the test DB is reset and the fixtures reloaded before each test that mutates data (for example TC-16 adds `outsider` to W1). Owned by T-03c, using `TEST_DATABASE_URL`.
- Do not commit real personal accounts, emails or tokens. The accounts used for manual checks belong to the tester and are recorded only in redacted form. Playwright `storageState` stays gitignored.
- **Production:** manual checks only, and no fixture seeding.

## 3. Mocked auth vs real Google SSO

Mocked or test-only auth (DP8) and synthetic profile claims **do not prove that Google SSO works**. They only exercise our own hook and authorization code. They do not test Google's token signature, the `hd` claim issuance, Better Auth's provider enforcement, redirect URIs or the OAuth client setup. Those require a **real Google login**. Under P11 the default place is **production** (TC-40 to TC-42). A stable preview domain is used only if P11 approves one. Real Google login additionally depends on P1, P4 and P9.

## 4. Evidence rules

- Every result carries one label: **real run** (a real command, its exit code and output excerpt), **mocked/simulated** (a real run that uses mocked auth, synthetic claims or mocked Blob), or **manual pending**.
- Real evidence means the command and output, the test report, and for manual cases the date, environment, URL, and redacted screenshots or logs recorded in `docs/status.md`. It never contains secrets or unredacted personal emails.
- A mocked/simulated pass never closes AC-02, AC-03, AC-04, AC-33 or AC-35.
- Failing tests are reported. They are not skipped, weakened or deleted.

## 5. Entry and exit criteria

**Entry (per task):** PRD and plan approved (R5.1). P3 approved. Test writing authorized for the task. Test DB and env ready. The case's dependencies are resolved.
**Exit (iteration):** every applicable case is run and passing, with a real-run label (or manual with evidence). Conditional cases are either run or explicitly marked N/A by a recorded decision. No open high-severity defects. The AC → TC table is complete. AC-35 evidence is recorded.

## 6. Test cases

Legend. **Auth:** Mock = mocked/test-only auth (DP8). Real = real Google login. None = no session or not applicable. **Mode:** A = automated, Man = manual. Every case has status **Not executed**.

### 6.1 Authentication (R1)

| ID | Req / AC | Preparation | Action | Expected | Level | Mode | Auth | Depends | Status |
|---|---|---|---|---|---|---|---|---|---|
| TC-01 | R1.2 / AC-02 | Test DB. Synthetic profile: `hd`=allowed, `email_verified`=true. **Simulated:** the callback-level mocking is designed in the T-06a spike | Run the sign-in hook and callback path with the synthetic profile | User and session created, redirect to `/` | I | A | Mock (simulated claims) | DP1 | Not executed |
| TC-02 | R1.2 / AC-03 | Synthetic profile with `hd`=`other.test` | Same as TC-01 | Rejected. 0 new `user`, `session` and `account` rows | I | A | Mock | DP1 | Not executed |
| TC-03 | R1.2 / AC-04 | Synthetic profile with no `hd`, `@gmail.com` | Same as TC-01 | Rejected, 0 rows | I | A | Mock | DP1 | Not executed |
| TC-04 | R1.2 / AC-05 | None | Call the defensive check with `email_verified`=false, missing `hd`, wrong `hd`, and the valid case. (The "email domain wrong" case was removed on 2026-09-30 to match approved R1.2 and AC-05: the rule is `hd` plus `email_verified` only.) | Only the valid case passes | U | A | None | — | Not executed |
| TC-05 | R1.3 / AC-06 | None | (a) Search `src/` for `azumo.com` and `azumo.co`. (b) Load env with `ALLOWED_GOOGLE_HD` unset, empty and `*` | (a) 0 matches. (b) Validation throws, and no sign-in succeeds | U | A | None | — | Not executed |
| TC-06 | R1.4 / AC-01 | No session | GET every app route: redirects to `/sign-in`. Call every non-auth API route and every server action: 401 or error | Redirect, 401, no data, no DB change | E2E+I | A | None | — | Not executed |
| TC-07 | R1.5 / AC-07 | `bob` signed in | Sign out, then request `/` | Session row deleted, redirect to `/sign-in` | E2E | A | Mock | DP8 | Not executed |
| TC-08 | R1.1 / AC-36 | None | Evaluate the test-auth guard with `VERCEL_ENV=production`, and with `ENABLE_TEST_AUTH` unset | Guard disabled in both cases | U | A | None | DP8 | Not executed |

### 6.2 Workspaces, multi-membership and role separation (R2, R3)

| ID | Req / AC | Preparation | Action | Expected | Level | Mode | Auth | Depends | Status |
|---|---|---|---|---|---|---|---|---|---|
| TC-09 | R2.1 / AC-08 | Fixtures | `alice` lists workspaces (UI and API) | Exactly W1 and W2, never W3 | I+E2E | A | Mock | — | Not executed |
| TC-10 | R2.2 / AC-09 | Fixtures | Create with names of 0, 1, 100 and 101 characters | 1 and 100 succeed, and the creator gets the management role. 0 and 101 rejected | I | A | Mock | P5, PR3 | Not executed |
| TC-11 | R2.4 / AC-13 | W1 and W2 pages | `alice` switches W1 → W2 → W1 | The page list shows only the selected workspace's pages | E2E | A | Mock | — | Not executed |
| TC-12 | R2.3, R3.2 / AC-37, AC-15, AC-18 | `alice` = Owner in W1, Viewer in W2 | In W1: create page, rename, manage members (allowed). Switch to W2 and repeat. Also go W2 → W1 → W2 to catch a cached role | W1 allowed. W2 returns 403 for every write, the UI hides W2 write controls, and no W2 rows change. The role never carries over between workspaces | I+E2E | A | Mock | PR3 | Not executed |
| TC-13 | R3.1 / AC-14 | Test DB | Insert a duplicate (user, workspace) membership. Insert `role='admin'` | Unique violation. CHECK violation | I | A | None | PR3, DP9 | Not executed |
| TC-14 | R3.2 / AC-15 | None | Call `can(role, action)` for every cell in the §5 matrix | Matches the matrix exactly | U | A | None | PR3, DP5 | Not executed |
| TC-15 | R3.2 / AC-15 | Fixtures | Direct server call for every role × action (Owner `alice`, Editor `bob`, Viewer `carol`) in W1 | Allowed → success. Denied → 403 and no DB change | I | A | Mock | PR3, PR1, DP5 | Not executed |
| TC-16 | R3.3 / AC-16 | Fixtures | `alice` adds `outsider` to W1, changes `bob` to Viewer, then removes `bob`. `bob` sends his next request. `carol` tries the same actions | Actions succeed. `bob` gets 404 on W1. `carol` gets 403 | I+E2E | A | Mock | P6, PR3, DP2 | Not executed |
| TC-17 | R3.3 / AC-17 | W1 has one Owner | Demote or remove the last Owner | 409, membership unchanged | I | A | Mock | DP3 | Not executed |
| TC-18 | R3.4 / AC-18 | `carol` (Viewer) | Open the page, workspace and members views | No edit, delete, attach, rename or manage controls rendered | E2E | A | Mock | PR3 | Not executed |

### 6.3 Isolation and ID substitution (R2.3)

| ID | Req / AC | Preparation | Action | Expected | Level | Mode | Auth | Depends | Status |
|---|---|---|---|---|---|---|---|---|---|
| TC-19 | R2.3 / AC-10 | `outsider`, and `bob` (not in W2) | GET W2's workspace, page, member list, attachment and file download by URL and API | 404 for all. The body has no W2 data | I+E2E | A | Mock | DP2 | Not executed |
| TC-20 | R2.3 / AC-11 | Snapshot of W2 rows | `bob` calls page create/edit/delete, attachment add/delete and member add/change/remove on W2 | All rejected (404). The snapshot is unchanged | I | A | Mock | DP2, PR1 | Not executed |
| TC-21 | R2.3 / AC-38, AC-11, AC-12, AC-25 | `alice` (Owner W1, Viewer W2) | Write-side ID substitution: (a) edit a W2 `pageId` with `workspaceId`=W1 in the payload; (b) add an attachment to a W1 page with `workspaceId`=W2; (c) change a W2 membership's role from a W1 context; (d) `registerUpload` with a `ws/{W2}/…` pathname | Authorization uses the resource's real workspace. 403 or 404. 0 rows affected | I | A | Mock | PR1, P2, PR3 | Not executed |
| TC-22 | R2.3 / AC-12 | Codebase | (a) Static check: the DB client is imported only under `src/server/`. (b) Call each data function as a non-member | (a) 0 violations. (b) Each function returns nothing or throws NotFound | U+I | A | Mock | — | Not executed |
| TC-23 | R4.3 / AC-25 | Test DB | Insert an attachment with a `workspace_id` different from its page's | FK violation | I | A | None | P2 | Not executed |

### 6.4 Pages and persistence (R4.1, PR1, PR2)

| ID | Req / AC | Preparation | Action | Expected | Level | Mode | Auth | Depends | Status |
|---|---|---|---|---|---|---|---|---|---|
| TC-24 | R4.1 / AC-19 | Fixtures | `bob` creates a page in W1. `carol` tries to create one | The page appears in W1's list and not in W2's. `carol` gets 403 | I+E2E | A | Mock | PR3 | Not executed |
| TC-25 | R4.1 / AC-20 | Page with attachments | `carol` opens the page | Title, content and attachment list shown | E2E | A | Mock | P2 | Not executed |
| TC-26 | R4.1, PR1 / AC-27 | Page created by `bob` | Reload, then sign out and back in (A1). If PR1: edit the title and content, then reload. `carol` tries to edit | Data persists across reloads and sessions. `carol` gets 403 | E2E+I | A | Mock | PR1 (edit part) | Not executed |
| TC-27 | PR2 / AC-29 | Editor available | Save H1–H3, bold, italic and both list types, then reload | Stored JSON equals the saved JSON | E2E | A | Mock | PR2, P7 | Not executed |
| TC-28 | PR2 / AC-30 | None | Save `<script>` and `onerror=` payloads, then view the page. Search the code for `dangerouslySetInnerHTML` | No dialog, no global flag set, 0 usages | E2E+U | A | Mock | PR2 | Not executed |
| TC-29 | PR1 / AC-28 | Page with attachments | `bob` deletes the page | GET returns 404. Attachment rows removed (and blobs, if uploads are in scope) | I | A | Mock | PR1, DP4, DP5 | Not executed |

### 6.5 Files — links (conditional: P2 ∈ {link, both})

| ID | Req / AC | Preparation | Action | Expected | Level | Mode | Auth | Depends | Status |
|---|---|---|---|---|---|---|---|---|---|
| TC-30 | R4.2 / AC-21 | W1 page | `bob` adds an `https:` link with a display name, then reloads | Link persists. Rendered with `target="_blank" rel="noopener noreferrer"` | I+E2E | A | Mock | P2, DP6 | Not executed |
| TC-31 | R4.2 / AC-21 | None | Validate `http:`, `javascript:`, `data:`, malformed URLs, and 2048- and 2049-character URLs. Spy on outbound fetch | Only a valid URL of ≤2048 characters is accepted. No server fetch occurs | U+I | A | Mock | P2, DP6 | Not executed |
| TC-32 | R4.4 / AC-26 | W1 link | `bob` deletes the link. `carol` tries. `outsider` tries | Row removed. 403. 404 | I | A | Mock | P2, PR3 | Not executed |

### 6.6 Files — uploads (conditional: P2 ∈ {upload, both})

Integration tests mock `@vercel/blob`, so they are **simulated**. Real Blob behavior is covered only by TC-43.

| ID | Req / AC | Preparation | Action | Expected | Level | Mode | Auth | Depends | Status |
|---|---|---|---|---|---|---|---|---|---|
| TC-33 | R4.2 / AC-22 | W1 page | Call `POST /api/uploads` as `bob`, `carol`, `outsider` and with no session | Token issued only to `bob`, with the forced `ws/{W1}/pg/{id}/` prefix. `carol` 403, `outsider` 404, no session 401 | I | A | Mock | P2, PR3 | Not executed |
| TC-34 | R4.2 / AC-23 | Configured limits | Request tokens for an oversized file and a disallowed type. Call `registerUpload` with a missing blob or a foreign prefix | All rejected. No row created | I | A | Mock | P2, P8 | Not executed |
| TC-35 | R4.3 / AC-24 | W1 upload | `GET /api/files/{id}` as `carol`, `outsider` and with no session. Search HTML and JSON responses for the blob host | 200 stream with `private, no-cache`, `attachment` and `nosniff`. 404. 401. No raw blob URL in any response | I+E2E | A | Mock | P2, DP7 | Not executed |
| TC-36 | R4.4 / AC-26 | W1 upload | `bob` deletes it. `carol` tries | Row removed and `del()` called with the pathname. `carol` gets 403 | I | A | Mock | P2, PR3 | Not executed |

### 6.7 Secrets, deployment and post-deployment

| ID | Req / AC | Preparation | Action | Expected | Level | Mode | Auth | Depends | Status |
|---|---|---|---|---|---|---|---|---|---|
| TC-37 | R6.2 / AC-34 | Repository | Check `.gitignore` for `.env*` (except `.env.example`). Run a secret-pattern scan. Check that `.env.example` has names only | 0 findings | U | A | None | — | Not executed |
| TC-38 | R6.1 / AC-33 | Deploy authorized | Open the production URL. Check the Vercel deployment metadata for the project, repository and commit SHA | The app is served, built from the authorized repository | Man | Man | None | P4, P10 | Not executed |
| TC-39 | R1.1 / AC-36 | Production | Confirm `ENABLE_TEST_AUTH` is not listed among the production env var names (do not decrypt values). Attempt email/password sign-in against the Better Auth endpoint. Check the production build has no test-auth module | Unset, email/password rejected, Google only | Man | Man | None | P4, DP8 | Not executed |
| TC-40 | R1.2, R6.3 / AC-02, AC-35 | Production. Account on the authorized domain | Sign in with Google, reach `/`. Then sign out and repeat AC-07 | Session created, then invalidated. Evidence recorded | Man | Man | **Real** | P1, P4, P9, P11 | Not executed |
| TC-41 | R1.2, R6.3 / AC-03, AC-35 | Production. Google Workspace account on another domain | Attempt sign-in. Check the DB for rows (read-only) | Rejected. No `user` or `session` row | Man | Man | **Real** | P1, P9, P11 | Not executed |
| TC-42 | R1.2, R6.3 / AC-04, AC-35 | Production. Personal Gmail account | Same as TC-41 | Rejected. No rows | Man | Man | **Real** | P1, P9, P11 | Not executed |
| TC-43 | R1.4, R2.3, R4 / AC-01, AC-10, AC-24 | Production. Two authorized real accounts (A, B) if available | Smoke test: no-session redirect. A creates a workspace and page, adds a link or upload, downloads the upload. B opens A's page URL. A deletes the attachment and confirms the file no longer downloads | Everything works. B is denied (404 if DP2). After deletion the file is not available | Man | Man | **Real** | P1, P2, P4, P9 | Not executed |
| TC-44 | R5 / AC-31, AC-32 | `docs/status.md` | Reviewer inspects the approval entry and the task entries | Approval dated before the first task. Every task lists its requirement and AC IDs | Man | Man | None | — | Not executed |

## 7. Execution

Nothing has been executed. No commands were run and there are no results. Every case is **Not executed**.

## 8. AC → TC traceability

The full requirement → AC → task → test mapping is in `docs/requirements-traceability.md`.

| AC | TC | AC | TC | AC | TC |
|---|---|---|---|---|---|
| AC-01 | TC-06, TC-43 | AC-13 | TC-11 | AC-25 | TC-21, TC-23 |
| AC-02 | TC-01, **TC-40** | AC-14 | TC-13 | AC-26 | TC-32, TC-36, TC-43 |
| AC-03 | TC-02, **TC-41** | AC-15 | TC-12, TC-14, TC-15 | AC-27 | TC-26 |
| AC-04 | TC-03, **TC-42** | AC-16 | TC-16 | AC-28 | TC-29 |
| AC-05 | TC-04 | AC-17 | TC-17 | AC-29 | TC-27 |
| AC-06 | TC-05 | AC-18 | TC-12, TC-18 | AC-30 | TC-28 |
| AC-07 | TC-07, TC-40 | AC-19 | TC-24 | AC-31 | TC-44 |
| AC-08 | TC-09 | AC-20 | TC-25 | AC-32 | TC-44 |
| AC-09 | TC-10 | AC-21 | TC-30, TC-31 | AC-33 | TC-38 |
| AC-10 | TC-19, TC-43 | AC-22 | TC-33 | AC-34 | TC-37 |
| AC-11 | TC-20, TC-21 | AC-23 | TC-34 | AC-35 | TC-40, TC-41, TC-42 |
| AC-12 | TC-21, TC-22 | AC-24 | TC-35, TC-43 | AC-36 | TC-08, TC-39 |
| AC-37 (proposed) | TC-12 | AC-38 (proposed) | TC-21 | | |

Coordinator correction: TC-12 was removed from AC-19, which it doesn't test (RV-12), and AC-26 now also points to TC-43.

Bold entries are the only cases that can close their AC with real Google evidence.

## 9. Ambiguous or untestable ACs (QA's original suggestions)

**Status:** the coordinator applied these in `docs/PRD.md` v2, following the reviewer. AC-29 uses the reviewer's wording instead of QA's. AC-11 and AC-15 put the 404 behind "(if DP2)". AC-37 and AC-38 were added to the PRD as QA proposals, pending approval.

| AC | Issue | Suggested wording |
|---|---|---|
| AC-01 | "Any app page" has no enumerated list. Server actions are not covered | "Every route in the route inventory redirects; every non-auth route handler returns 401 and every server action returns an Unauthenticated error, with no DB change." |
| AC-03 | Checks `user` and `session` but not `account` | Add "…or `account` row." |
| AC-06 | "No sign-in succeeds" does not define the observable result | "App startup or config validation throws; the sign-in endpoint returns a non-2xx response." |
| AC-11 | "Rejected" has no status code, which conflicts with DP2 | "…return 404 (DP2) and W's rows are unchanged." |
| AC-12 | "Returns nothing" is ambiguous (null, empty list or throw) | "…returns an empty result or throws NotFound." |
| AC-15 | "403 for denied" conflicts with the matrix's non-member column (404) | "403 for denied member roles; 404 for non-members (AC-10)." |
| AC-18 | Limited to "page UI", but rename and member controls live elsewhere | "No UI view renders…" |
| AC-23 | Untestable until P8 sets the limits | Keep conditional on P8 and list the concrete values once decided. |
| AC-26 | Blob deletion can only be simulated in integration tests | "`del()` is called (integration); a manual check confirms the blob is gone (TC-43)." |
| AC-29 | Editors normalize JSON (IDs, default attributes), so strict equality may fail | "The JSON loaded after a reload deep-equals the JSON loaded after a second save." |
| AC-30 | "Does not run" needs a detection method | "No dialog event and no `window.__xss` flag is set during view." |
| AC-33 | "Built from the authorized repository" needs evidence | "Vercel deployment metadata shows the authorized repository and commit SHA." |
| AC-35 | Needs a non-domain Workspace account and a Gmail account. Evidence may expose PII | Name who provides the accounts, and require redacted emails in evidence. |

**Coverage gaps (proposals only):**
- No AC covers the same user holding different roles in different workspaces (TC-12). Proposed AC-37.
- No AC covers payload ID substitution by a member (TC-21). Proposed AC-38.
- No dedicated AC for `workspace.rename`. It is covered only through AC-15.
- R1.1 ("no other sign-in method") is only partly covered by AC-36. TC-39 extends it.

## 10. Risks

- Real SSO is verifiable only in production (P11). Defects there show up late.
- The secondary-domain `hd` behavior (P1) is unverified.
- The `onUploadCompleted` callback does not reach localhost, so upload registration can only be checked for real in production.
- A test-auth leak into production would be critical. TC-08 and TC-39 cover it.

## 11. Coordinator changes after review (2026-09-29)

| Change | Source |
|---|---|
| Per-test DB reset (T-03c, `TEST_DATABASE_URL`) | Developer inconsistencies 8 and 9 |
| TC-01 explicitly labeled simulated; the mocking design depends on the T-06a spike | Developer inconsistency 6, RV-20 |
| TC-12 → AC-37 (not AC-19). TC-21 → AC-38 | RV-02, RV-12 |
| TC-39 no longer assumes a test-auth HTTP route; checks email/password is disabled | RV-05 |
| TC-43 gets a delete step (AC-26) | Reviewer, QA-rewordings section |
| §9 marked as applied in PRD v2 | RV-13 |
