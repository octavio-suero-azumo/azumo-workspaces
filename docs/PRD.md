# PRD: Azumo Workspaces (first iteration)

- **Status:** APPROVED on 2026-09-29, by the user's consolidated approval of v3 §0.
  - Approved: PR1–PR3, DP1–DP9, AC-37 and AC-38.
  - Decided: P1 = `azumo.co`, P2 = uploads, P8 = 10 MB plus common file types.
  - Not approved: DP10.
  - Still open: P4 (Vercel account and repository) and P10.
  - §0 prevails over later sections.
- **Origin:** drafted by `architect` (real invocation, agentId `af8ceef86d036f86e`) on 2026-09-29. The coordinator then applied the `reviewer` observations (agentId `a945a6d5953ce518b`) and QA's AC rewordings (agentId `a78afac0e6e2a6e3b`). Every change is listed in §11.
- **Sources:** `docs/brief.md` (source of truth), `docs/research.md`, `docs/agent-check.md`
- **Related:** `docs/architecture.md`, `docs/implementation-plan.md`, `docs/test-plan.md`, `docs/requirements-traceability.md`
- **Note on IDs:** the brief defines R1–R6, PR1–PR3 and P1–P4. **P5–P12, DP1–DP10 and A1–A4 are introduced by this PRD and are not in the brief.** They stay open or proposed until the user confirms them.

## 0. Accelerated iteration (v3, 2026-09-29)

> **Historical note (2026-09-30, RV-F-11):** this section was written before the approval. It was then **approved** by the user (see the header and the `docs/status.md` entry "Approval (AC-31)"). Its "not given yet" and "Proposed" wording is kept only as history: P8 = 10 MB plus common types is approved.

This section overrides §5–§8 where they conflict. The rest of the document still applies.

**Decided by the user on 2026-09-29 (consolidated question):**
- **P1 → `azumo.co`.** It is set only through configuration (`ALLOWED_GOOGLE_HD`). Only this domain is allowed; `azumo.com` is **not** enabled.
- **P2 → uploads to Vercel Blob.** Private store, token route, authorizing download (architecture §7). Links are not in scope. AC-21 and T-14 are dropped.
- **RV-17 → resolved.** `.claude/settings.json` was created with "ask" rules for commit, push, remote add, vercel, package installs, Playwright browser install, and edits to `LOCAL_ACCESS_CHECK.md`.
- **Consolidated approval → not given yet.** The user chose "Not approve yet". No implementation starts until they approve.

**Confirmed by the user on 2026-09-29.** The user's message lists these in the mandatory scope:
- **PR1 → approved:** page create, read, update and delete.
- **PR2 → approved:** basic formatted content with persistence.
- **PR3 → approved:** roles Owner, Editor and Viewer.

**Target:** one working day less than the brief's 2–3 days, so **2 working days**. The calendar date is not set and **needs user confirmation**. The plan is relative: Day 1 and Day 2 (`docs/implementation-plan.md` §0).

**Cut to save time:**
- DP10 (workspace rename) is out.
- The MCP is reduced to 5 fixed tools (`tools/bench-mcp`).
- E2E covers only the essential flows. The rest of the checks are integration tests that call the server directly.
- No preview SSO (P11 → production only).
- No visual polish.

**Not cut:** real Google login, server-side authorization, persistence, workspace isolation, essential tests, and deployment.

**Proposed defaults, part of the single consolidated approval:**

| Item | Proposed default |
|---|---|
| P3 stack | Next.js 16.3.x, Better Auth (Google only), Drizzle. Local dev and tests use **PGlite** (in-process Postgres, no Docker pull). Production uses Neon via Vercel. Tiptap StarterKit editor (P7). |
| P2 files | **Decided: uploads to a private Vercel Blob store.** |
| P8 (upload limits) | **Proposed:** maximum 10 MB per file. Allowed types: PDF, PNG, JPEG, GIF, WebP, plain text, CSV, and Office documents (docx, xlsx, pptx). |
| P5 | Any authenticated user of the allowed domain can create workspaces. |
| P6 | An Owner adds a member by email, but only users who have already signed in once. No invitations. |
| P9 | OAuth audience **External**. The domain is enforced server-side by `hd` + `email_verified`. **Internal** only if the user administers Azumo's Google organization. |
| P10 / P11 | Plan to be defined together with P4. SSO verified in production only. |
| DP1–DP9 | Adopted as designed. |
| DP10 | Dropped. |
| AC-37 / AC-38 | Adopted. |
| A1 | Superseded by PR1. |

**Still requires the user:**
- **P4 (Vercel account and repository):** needed before deploy. Uploads also need it **earlier**, because even local development needs a real Blob store token, on Day 2 AM.
- Deploy authorization.

## 1. Goal

Deliver a working web app inspired by Notion and deployed on Vercel. Only people from the authorized corporate Google domain can sign in. Users can have several workspaces, work inside each one under a role, and create pages that carry file references. The first iteration has to fit in 2–3 days (see P12). Every feature must trace to a requirement, an acceptance criterion and evidence.

## 2. Users

| User | Description |
|---|---|
| Corporate user | A person with a Google account in the authorized domain (the domain is P1). Can sign in. |
| Workspace member | A corporate user with a membership in a workspace. Their role controls what they can do there (role values are PR3). |
| Workspace manager | A member whose role allows managing members. Under PR3 this is the Owner. |
| Rejected user | Any Google account outside the authorized domain, including personal Gmail. Can never get a session. |

## 3. Assumptions (the user confirms them explicitly when approving)

- **A1.** R4 ("pages with files") implies at least **create page** and **view page**, because otherwise no page could exist. Full CRUD (edit and delete) stays in PR1. T-10 depends on this assumption being confirmed.
- **A2.** *(pending P1, not a default)* The design reads the allowed domain from one configured value (`ALLOWED_GOOGLE_HD`). If P1 resolves to more than one domain, or to a primary domain with secondary domains, T-06a needs changes that must be approved first.
- **A3.** Pages are flat: no nesting and no page hierarchy.
- **A4.** The app uses only test fixtures and never production data.

## 4. Mandatory requirements (from the brief)

| ID | Sub-ID | Statement |
|---|---|---|
| R1 | R1.1 | The only way to sign in is Google SSO (OIDC). No other sign-in method is enabled in production. |
| | R1.2 | The server accepts a sign-in only if the verified ID token has `email_verified = true` and an `hd` claim equal to the configured allowed domain. Hiding the domain in the UI or using the `hd` request parameter does not count as enforcement. Whether the email's own domain must also match is **pending P1**. |
| | R1.3 | The allowed domain comes only from configuration. No domain literal appears in the source code. If the value is missing, empty or `*`, the app fails closed. |
| | R1.4 | Every app page, API route and server action except the auth endpoints requires a valid session. |
| | R1.5 | Users can sign out, and signing out invalidates the session. |
| R2 | R2.1 | A user can belong to more than one workspace and sees only the workspaces where they are a member. |
| | R2.2 | Workspaces can be created, and the creator gets the management role. Who is allowed to create workspaces is P5. |
| | R2.3 | Workspaces are isolated. The server scopes every read and write of workspace data by the requester's membership. |
| | R2.4 | A user can switch between their workspaces. |
| R3 | R3.1 | Each (user, workspace) pair has at most one membership, with exactly one role from the configured role set (role values: PR3). |
| | R3.2 | The server authorizes every action against the permission matrix (`docs/architecture.md` §5). |
| | R3.3 | Members can be added, have their role changed, and be removed by a role that is allowed to manage members. How members are added is P6. |
| | R3.4 | The UI hides controls for actions the user isn't allowed to do. This is a convenience only and never replaces R3.2. |
| R4 | R4.1 | Pages belong to exactly one workspace. Authorized members can create them and all members can view them (A1). |
| | R4.2 | A page can carry file references: links, uploads, or both, depending on P2. |
| | R4.3 | Access to a file reference requires the same authorization as the page it belongs to, including the download of uploaded files. |
| | R4.4 | Authorized members can remove file references. |
| R5 | R5.1 | The user approves `docs/PRD.md` and `docs/implementation-plan.md` before any feature task starts. |
| | R5.2 | Every implementation task traces to requirement IDs and acceptance criteria. |
| R6 | R6.1 | The app is deployed on Vercel from the authorized account and repository (P4). |
| | R6.2 | Secrets live only in Vercel environment variables or in local `.env.local` files that are not committed. |
| | R6.3 | Google SSO is verified manually in production, and the evidence is recorded. |

## 5. Proposals pending validation (not approved)

| ID | Proposal | Source |
|---|---|---|
| PR1 | Full page CRUD: edit and delete in addition to A1. | Brief |
| PR2 | Page content with basic formatting (headings, bold, italic, lists), persisted. | Brief |
| PR3 | Roles: Owner, Editor, Viewer. | Brief |
| DP1 | Better Auth with a **custom** membership table, instead of the organization plugin whose roles don't match PR3. | Architect |
| DP2 | Non-member access to any workspace resource returns **404**. A member without enough permission gets **403**. | Architect |
| DP3 | A workspace always keeps at least one Owner. Demoting or removing the last Owner returns 409. | Architect |
| DP4 | Deleting a page is a hard delete that cascades to its attachment rows, and to their blobs when uploads are enabled. | Architect |
| DP5 | Editors can delete pages. The alternative is Owner-only deletion. | Architect |
| DP6 | Link attachments accept only `https:` URLs of at most 2048 characters. The server never fetches the URL. | Architect |
| DP7 | Uploaded files are always served with `Content-Disposition: attachment`, never inline. | Architect |
| DP8 | E2E tests use a test-only auth module (Better Auth `testUtils`), imported only by test setup and without an HTTP route. It is disabled whenever `VERCEL_ENV=production` or `ENABLE_TEST_AUTH` is not set. | Architect, refined by developer and reviewer |
| DP9 | Versioned Drizzle migrations (`generate` + `migrate`). `push` is used only for local experiments. | Research §5 |
| DP10 | An Owner can rename a workspace. This isn't in the brief; drop it if not approved. | Architect (reclassified by reviewer RV-09) |

## 6. Open decisions (not resolved)

| ID | Decision | Blocks |
|---|---|---|
| P1 | Authorized SSO domain. **Do not choose one and do not allow both without explicit confirmation.** Also open: whether `azumo.com` and `azumo.co` belong to the same Google organization (research §3, unverified). | T-06a final configuration, T-19 |
| P2 | Files: link, upload or both. | T-13 to T-16 |
| P3 | Tech stack. The proposal is in `docs/architecture.md` §1. | T-01 and everything after it |
| P4 | Authorized Vercel account and repository. | T-15, T-18, T-19 |
| P5 | Who can create workspaces: any authenticated user, or a restricted set. | T-08 |
| P6 | How members are added: only users who have already signed in, or pending invites by email. | T-09 |
| P7 | Editor: BlockNote core or Tiptap StarterKit (a sub-decision of P3; only if PR2 is approved). | T-11 |
| P8 | If uploads are chosen: maximum file size and allowed content types. | T-15 |
| P9 | Google OAuth audience (Internal or External) and who owns the OAuth client. | T-06a manual verification, T-19 |
| P10 | Vercel plan: Hobby (non-commercial clause) or an Azumo Pro team. | T-18 |
| P11 | Is Google SSO needed on a stable preview domain, or is testing SSO only in production acceptable? | T-18 |
| P12 | Scope vs time: the sum of task-size ceilings exceeds 2–3 days (`docs/implementation-plan.md` §0). Decide what to cut or defer. | Iteration-1 scope |

## 7. Minimum scope (iteration 1)

- Google SSO with the configured domain check.
- Workspaces: create, list, switch. Rename only if DP10 is approved.
- Members: list, add, change role, remove.
- Pages: create, list, view (A1). Edit and delete only if PR1 is approved. Formatted content only if PR2 is approved.
- File references following P2.
- Server-side authorization and cross-workspace isolation.
- Deployment to Vercel.

## 8. Out of scope (iteration 1)

- Real-time collaboration, comments, mentions and notifications.
- Nested pages, databases/tables, templates, search, page history and versioning.
- Deleting a workspace, leaving a workspace, transferring ownership (beyond R3.3), audit log.
- Public or shared links and guests outside the domain.
- Email invitations with delivery (P6 may add pending invites, but no email is sent).
- File previews, image thumbnails, virus scanning.
- Mobile-specific UI, internationalization, dark mode.
- Collaboration or Pro Tiptap extensions and BlockNote `xl-*` packages (licensing).
- Any MCP tool that writes to or deploys the app.

## 9. User stories

- **US-1 (R1):** As a corporate user, I sign in with Google and reach my workspaces. If my account is outside the domain, I'm rejected.
- **US-2 (R2):** As a user, I create a workspace, see only my workspaces, and switch between them.
- **US-3 (R3):** As a workspace manager, I add a colleague with a role, change that role, or remove them.
- **US-4 (R4):** As a member with edit rights, I create a page and attach file references to it. As any member, I view the page and open its files.
- **US-5 (PR1/PR2):** As a member with edit rights, I edit a page's formatted content and it persists. I can delete the page.

## 10. Acceptance criteria

- **Denied** means: an error response (HTTP error, or a server action error result) that contains no data from the target workspace, and no database change.
- **Proposal-dependent details** (status codes, limits, headers) appear in separate "(if DPx)" clauses. Approving an AC does not approve the DP inside it.

| AC | Req | Criterion (verifiable) |
|---|---|---|
| AC-01 | R1.4 | Without a session: every route in the route inventory redirects to `/sign-in`. Every non-auth route handler returns 401. Every server action returns an Unauthenticated error. No DB change. |
| AC-02 | R1.2 | A Google account whose ID token has `hd` equal to `ALLOWED_GOOGLE_HD` and `email_verified=true` gets a session and reaches `/`. |
| AC-03 | R1.2 | A Google Workspace account from a different domain is rejected. Afterward, no new `user`, `session` or `account` row exists for it. |
| AC-04 | R1.2 | A personal Gmail account (no `hd`) is rejected, and no rows are created. |
| AC-05 | R1.2 | Unit test: the defensive check rejects when `email_verified` is false, when `hd` is missing, or when `hd` differs from the configured value. Whether the email domain must also match is pending P1. |
| AC-06 | R1.3 | Searching `src/` for `azumo.com` or `azumo.co` finds 0 matches. With `ALLOWED_GOOGLE_HD` unset, empty or `*`, app startup or config validation throws, and the sign-in endpoint returns a non-2xx response. |
| AC-07 | R1.5 | After sign-out, the session row is gone and the next request redirects to `/sign-in` (the cookie cache is disabled, per architecture §4). |
| AC-08 | R2.1 | A user who belongs to W1 and W2, but not W3, sees exactly W1 and W2 in the workspace list UI and from the `listMyWorkspaces` data function. |
| AC-09 | R2.2 | A workspace name is trimmed first. Creating a workspace with a 1–100 character name creates the workspace plus a membership for the creator with the management role. Empty, whitespace-only and longer names are rejected. The permission policy follows P5. |
| AC-10 | R2.3 | A non-member who requests any workspace, page, member list or attachment of W by URL, route handler or server action is denied. *(if DP2)* The status is 404. |
| AC-11 | R2.3 | A non-member's attempts to create, edit or delete a page, add or delete an attachment, or manage members in W are all denied, and W's rows are unchanged. *(if DP2)* The status is 404. |
| AC-12 | R2.3 | The DB client is imported only under `src/server/`. Each workspace-scoped data function takes the requester's context and, for a non-member, returns an empty result or throws NotFound (integration test per function). |
| AC-13 | R2.4 | Switching workspace changes the page list to the selected workspace's pages only. |
| AC-14 | R3.1 | A duplicate (user, workspace) membership insert fails with a unique constraint error. A role outside the configured set fails the DB check. |
| AC-15 | R3.2 | For every member role × action cell of the matrix, a direct server call (not through the UI) succeeds for "allowed" and is denied for "denied". *(if DP2)* The denial is 403 for member roles and 404 for non-members (AC-10). |
| AC-16 | R3.3 | *(conditional on P6)* A manager can add a member, change a role and remove a member. On their next request, the removed user is denied for that workspace. A non-manager's attempt is denied. *(if DP2)* Removed user 404, non-manager 403. |
| AC-17 | R3.3 | *(if DP3)* Demoting or removing the last Owner returns 409, and the membership is unchanged. |
| AC-18 | R3.4 | No UI view renders edit, delete, attach, rename or member-management controls for a role that lacks those actions. |
| AC-19 | R4.1 | A member allowed to create pages creates one. It appears in its own workspace's page list and in no other. A member without that permission is denied (*if DP2*: 403), and so is a non-member (*if DP2*: 404). |
| AC-20 | R4.1 | Any member can open the page, which shows its title, content and attachment list. Without PR2, content is plain text set at creation. |
| AC-21 | R4.2 | *(P2 includes links)* Adding a valid URL with a display name persists it and shows it on the page. `javascript:`, `data:` and malformed URLs are rejected. The server never fetches the URL. The rendered link has `rel="noopener noreferrer"`. *(if DP6)* Only `https:` is accepted, and URLs over 2048 characters are rejected. |
| AC-22 | R4.2 | *(P2 includes uploads)* The upload token route issues a token only to members allowed to add attachments on that page. Others are denied, and an unauthenticated user gets 401. *(if DP2)* Viewer 403, non-member 404. |
| AC-23 | R4.2 | *(uploads, conditional on P8)* Files over the configured size or with a disallowed content type are rejected. The concrete values are listed once P8 is decided. |
| AC-24 | R4.3 | *(uploads)* `GET /api/files/{attachmentId}` streams the file to a member. A non-member is denied, and an unauthenticated user gets 401. The response has `Cache-Control: private, no-cache` and `X-Content-Type-Options: nosniff`. No raw blob URL appears in any HTML or JSON response. *(if DP7)* It also has `Content-Disposition: attachment`. *(if DP2)* Non-member 404. |
| AC-25 | R4.3 | The DB rejects an attachment whose `workspace_id` differs from its page's `workspace_id` (composite FK). |
| AC-26 | R4.4 | An allowed role deletes an attachment: the row is removed. For uploads, `del()` is called in integration, and a manual check confirms the blob is gone (TC-43). A role without permission is denied. |
| AC-27 | PR1 | *(if PR1 is approved)* An edited title or content is still there after a reload. A Viewer's edit is denied. |
| AC-28 | PR1 | *(if PR1 is approved)* After deleting a page, GET is denied as not found, and its attachment rows are gone (DP4). |
| AC-29 | PR2 | *(if PR2 is approved)* After content with H1–H3, bold, italic, bulleted and numbered lists is saved and the page reloaded, the editor's serialized document deep-equals its serialized document from just before the save. |
| AC-30 | PR2 | *(if PR2 is approved)* After content with a `<script>` or an `onerror=` payload is saved and viewed, no dialog event fires and no `window.__xss` flag is set. No `dangerouslySetInnerHTML` is used on user content. |
| AC-31 | R5.1 | `docs/status.md` records user approval of the PRD and plan, with a date, before the first feature task entry. |
| AC-32 | R5.2 | Each task entry in `docs/status.md` lists its requirement and AC IDs. |
| AC-33 | R6.1 | The production URL serves the app. The Vercel deployment metadata shows the authorized project, repository and commit SHA. |
| AC-34 | R6.2 | No secret values are in the repository: `.env*` files except `.env.example` are gitignored, and a secret-pattern search finds 0 matches. |
| AC-35 | R6.3 | AC-02, AC-03 and AC-04 are repeated manually in production, and the evidence is recorded in `docs/status.md`: screenshots or logs, no secrets, emails redacted. The user names who provides the three test accounts. |
| AC-36 | R1.1 | The test-auth module is imported only by test setup. A unit test shows the guard is disabled when `VERCEL_ENV=production` or `ENABLE_TEST_AUTH` is unset. The production Better Auth config enables only the Google social provider, with `emailAndPassword` disabled. |
| AC-37 | R2.3, R3.2 | **Proposed by QA, pending approval.** A user with different roles in two workspaces (for example Owner in W1, Viewer in W2) gets the permissions of their role in each workspace. The role never carries over between workspaces, including after switching back and forth. |
| AC-38 | R2.3 | **Proposed by QA, pending approval.** A member who puts another workspace's ID in a request payload (`workspaceId`, `pageId`, `membershipId` or an upload pathname) is authorized against the resource's real workspace. The request is denied and 0 rows are affected. |

## 11. Coordinator changes after review (2026-09-29)

These apply the observations of `reviewer` (RV-xx), `qa` (test-plan §9) and `developer` (plan §4). Nothing here resolves an open decision or approves a proposal.

| Change | Source |
|---|---|
| Header: added the note that P5–P12, DP* and A* aren't in the brief | RV-10 |
| A1 now needs explicit confirmation. A2 marked "pending P1, not a default" | RV-09, RV-01 |
| R1.2 and AC-05 no longer require the email domain to match; that is left pending P1 | RV-01, developer inconsistency 2 |
| R1.4 and AC-01 now cover server actions | RV-06, QA |
| DP details moved into separate "(if DPx)" clauses in AC-10, 11, 15, 16, 19, 21, 22, 24 | RV-03, developer inconsistency 1 |
| Rename reclassified as proposal DP10 | RV-09 |
| DP8 and AC-36: no HTTP route, and the production config is Google-only | RV-05, developer inconsistency 5 |
| AC-37 and AC-38 added, labeled as QA proposals pending approval | RV-02 |
| QA rewordings applied to AC-03, 06, 08, 12, 18, 23, 26, 30, 33, 35. AC-29 uses the reviewer's wording | QA §9, RV (QA-rewordings section) |
| AC-09 now trims names and rejects whitespace-only ones. AC-16 conditional on P6. AC-20 defines content without PR2 | RV (additional ambiguous ACs) |
| Added P12 (scope vs time), and P4 now also blocks T-15 | RV-04, RV-15, developer RK-8 |

## 12. Scope expansion E1–E10 (requested by the user on 2026-10-01)

- **Not from the meeting.** This scope was **not** part of the original meeting or brief. The user authorized it explicitly on 2026-10-01 ("ESTA ES UNA AMPLIACIÓN AUTORIZADA DEL ALCANCE"). It updates §8 (out of scope) **only** for the features listed below.
- **Planner:** the `architect` agent produced the gap analysis, data model, permission matrix and ACs. The coordinator recorded the decisions in §12.4.

### 12.1 Features

| ID | Feature | Summary |
|---|---|---|
| E1 | Shell and theme | Compact ~250 px sidebar, breadcrumbs, centered document, borderless title, discreet menus. Light / Dark / System theme with central tokens. |
| E2 | Icons | Configurable icon per workspace (Owner) and per page (Owner, Editor) from a curated emoji allowlist (`src/lib/icons.ts`), with default and reset. Validated server-side. |
| E3 | Home | My workspaces, Recently edited pages (live pages only), upcoming events, create actions, empty states. |
| E4 | Calendar | Basic per-workspace calendar: month view, prev/next/Today, event CRUD, mobile agenda. No external sync, recurrence, invites or notifications. |
| E5 | Page "…" menu | Change icon, Copy link, Copy page contents, Share, Duplicate, Move to, Move to Trash. Font Default/Serif/Mono, Small text and Full width, persisted per page. |
| E6 | Settings | Theme; workspace name and icon (Owner); link to member management; read-only account; Sign out. |
| E7 | Share | Reuses workspace membership. Explicit confirmation that adding a member grants access to the WHOLE workspace. No emails, no public links. |
| E8 | Duplicate | Same workspace, new ids. Copies title, content, icon and presentation. Attachments are copied to independent blobs. Members and events are not copied. |
| E9 | Move to | Owner in the source workspace and page.create in the destination. Attachments are copied to the destination prefix, the DB switches in one transaction, and the originals are deleted only after commit. Retry-safe. |
| E10 | Trash and Restore | Soft delete (`deleted_at`, `deleted_by`). Trash view per authorized workspace; Restore re-checks current permissions. **Replaces hard delete in the UI** (supersedes DP4/AC-28). No empty-trash, permanent delete or auto-purge. |

**Still excluded:**
- Any AI feature.
- External calendar sync.
- Notifications and email.
- Real-time collaboration.
- Version history and present mode.
- Import/export.
- Automations.
- Public links and external users.
- Page trees.
- Lock page.

### 12.2 Data model (migrations 0003–0005, additive only)

- **`workspace.icon`** and **`page.icon`:** text, NULL = default icon; at most 16 code points.
- **`page.font`:** `default` | `serif` | `mono`.
- **`page.small_text`**, **`page.full_width`:** boolean, default false.
- **`page.deleted_at`**, **`page.deleted_by`:** paired: either both are set or both are NULL.
- **`attachment_page_workspace_fk`:** becomes `DEFERRABLE INITIALLY IMMEDIATE`. Move defers it inside its transaction, because the blob-pathname prefix CHECK is per row and cannot be deferred.
- **`calendar_event`:**
  - `start_date`/`end_date` are dates, end inclusive. They are used for all-day events and are never converted between time zones.
  - `start_at`/`end_at` are `timestamptz`, with `time_zone` (IANA). They are used for timed events.
  - A composite FK `(page_id, workspace_id) → page(id, workspace_id) ON DELETE SET NULL (page_id)`: an event can only link to a page of its own workspace.

### 12.3 Permissions (added to `can()`)

| Action | Owner | Editor | Viewer | Non-member |
|---|---|---|---|---|
| `workspace.edit` (name, icon) | Y | 403 | 403 | 404 |
| `page.move` (source workspace) | Y | 403 | 403 | 404 |
| `page.edit` (incl. icon and presentation), `page.duplicate`, `page.trash`, `page.restore`, `trash.view`, `event.create/edit/delete` | Y | Y | 403 | 404 |
| `page.view` (incl. `/p/{id}`, copy link and contents, Share list), `event.view` | Y | Y | Y | 404 |

**Trash rule:** a trashed page resolves only for `page.restore`. Every other action, including attachment downloads, upload registration, event links and `/p/{id}`, returns 404.

### 12.4 Decisions recorded by the coordinator

| ID | Decision |
|---|---|
| DP11 | The theme is a per-device cookie read by the root layout (`<html data-theme>`): no flash and no inline script. |
| DP12 | Icons come from a curated emoji allowlist only. |
| DP13 | Trash replaces the hard page delete in the UI. The hard-delete server action is removed, so no endpoint can permanently delete a page. |
| DP14 | Events linked to a trashed page hide the link; it reappears after Restore. |
| DP15 | The Trash view is for Owner/Editor. |
| DP16 | The stable link is `/p/{pageId}`, which redirects authorized users to the page's current location. The old `/w/{workspace}/p/{page}` URL keeps today's rule: 404 when the workspace does not match. |
| DP17 | Duplicate keeps the exact title. |
| DP18 | Home shows at most 10 recently edited pages and 10 upcoming events. |
| DP19 | Move to the page's current workspace is an idempotent no-op (`moved: false`, nothing changes) instead of a 400. Reason: E9 must be retry-safe. If a Move commits but the response is lost, the client's retry targets the workspace the page is already in, and a 400 would report a failure for a Move that succeeded. The UI never offers the current workspace as a destination. |
| Light tokens | Menu `#FFFFFF`, border `#E9E9E7` (not specified by the user). |

### 12.5 Acceptance criteria AC-39–AC-59

The full text is the planner's addendum, summarized here. The race ACs prove the ordering of operations, not real parallelism, because PGlite has a single connection.

| AC | Criterion |
|---|---|
| AC-39 | A DB at migration 0002 holding data migrates to 0005 with its data unchanged. |
| AC-40 | The DB rejects invalid icons, fonts, trash pairs, event shapes, end before start, and cross-workspace event→page links. Deleting a page nulls only the event's `page_id`. |
| AC-41 | Every new matrix cell is covered by a `can()` unit test and by a direct server call. Denials change 0 rows. |
| AC-42 | A trashed page returns 404 for everything except `page.restore`. It is absent from the sidebar, lists and Home. |
| AC-43 | The theme is server-rendered from the cookie. System follows the OS; an invalid value falls back to system. The tokens are as specified. |
| AC-44 | Icons can be set and reset. Unlisted values, HTML, SVG and URLs return 400 and change nothing. |
| AC-45 | Home shows only my live data, with create controls by permission and empty states. |
| AC-46 | Calendar month view, prev/next/Today, workspace selector limited to mine, event CRUD by role, validation, and a mobile agenda. |
| AC-47 | An all-day event stays on the same date for viewers in UTC−11, UTC and UTC+14. A timed event keeps one instant. |
| AC-48 | Event→page links stay within the workspace. A trashed page's title is never exposed. After a Move, the event stays in the source workspace with no link. |
| AC-49 | Copy link gives `{origin}/p/{id}`, which grants nothing. Members are redirected to the current location; everyone else gets an identical 404. |
| AC-50 | Copy contents produces plain text (Viewers too). Font, small text and full width persist for everyone; invalid values return 400. |
| AC-51 | Share explains the workspace-wide scope and requires confirmation before adding. It keeps azumo.co, P6 and the last-Owner rules. No email or public link. |
| AC-52 | Duplicate creates independent page and blobs, and copies no events or members. On failure, nothing is created. |
| AC-53 | Move transfers the page and attachments (identical bytes) to the destination prefix and deletes the originals after commit. Source-only members get 404. The UI blocks Move with unsaved changes or an active upload. |
| AC-54 | Move to the same workspace is a no-op (`moved: false`, DP19); a trashed page returns 404; attachments without Blob config return 503. In every case nothing changes. |
| AC-55 | An injected failure leaves the DB unchanged and the originals intact. A retry succeeds without duplicates. |
| AC-56 | Races: upload vs Move, save vs Move/Trash, upload registration vs Trash, revoked membership — all handled without cross-workspace rows. |
| AC-57 | Trash keeps content, rows and blobs. The Trash view lists title, workspace, date and actor. Restore re-checks the current role. |
| AC-58 | The theme persists. The Owner can edit the workspace name and icon. Settings links to members and shows the account read-only. |
| AC-59 | After removal, an ex-member gets 404 for that workspace's pages, links, files, calendar, Trash and Share, and Home drops them. |
