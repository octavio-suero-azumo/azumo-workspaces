# Research — Azumo Workspaces stack and platform behavior

- **Status:** Draft (informational). It resolves none of P1–P4 and promotes none of PR1–PR3.
- **Phase:** Planning, research step
- **Agent:** `researcher` (real invocation: yes, agentId `a9a8fba396aab4112`, 35 tool uses)
- **Date:** 2026-09-29
- **Prompt summary:** research current official docs for Google SSO domain restriction, framework, persistence, editor, files, testing and Vercel deployment. Recommend a primary and an alternative stack. Cover accounts, compatibility, limitations and costs.
- **Saved by:** the coordinator, from the agent's output verbatim. The only change is this header.

---

## 1. Question

What stack and platform setup would fit a 2–3 day, Notion-inspired prototype on Vercel? It must provide Google SSO restricted to a domain (R1), workspaces (R2), roles (R3), and pages with files (R4). Topics covered: auth, framework, database, editor, files, testing, and deployment.

## 2. Sources (all fetched 2026-09-29)

| URL | Supports |
|---|---|
| https://developers.google.com/identity/openid-connect/openid-connect | `hd` parameter vs `hd` claim; `email_verified`; server-side validation |
| https://support.google.com/cloud/answer/15549945 | OAuth audience Internal vs External; testing-mode limits |
| https://developers.google.com/identity/protocols/oauth2/web-server | Redirect URI rules (no wildcards, exact match) |
| https://better-auth.com/blog/authjs-joins-better-auth | Auth.js in maintenance mode; Better Auth recommended for new projects |
| https://authjs.dev/getting-started/providers/google | Auth.js Google callback URL and `signIn` domain check example |
| https://better-auth.com/docs/authentication/google | Better Auth `hd` option and server-side enforcement |
| https://better-auth.com/docs/concepts/database | Adapters (Drizzle/Prisma/Kysely), CLI, database hooks |
| https://better-auth.com/docs/plugins/organization | Multi-org membership and roles |
| https://better-auth.com/docs/plugins/test-utils | Programmatic test users and sessions |
| https://vercel.com/docs/functions/limitations | 4.5 MB request/response body limit; durations |
| https://vercel.com/docs/vercel-blob | Private vs public stores, OIDC auth |
| https://vercel.com/docs/vercel-blob/client-upload | Client uploads; auth in `onBeforeGenerateToken`; callback won't reach localhost |
| https://vercel.com/docs/vercel-blob/private-storage | Serving private blobs through an authorizing route |
| https://vercel.com/docs/vercel-blob/usage-and-pricing | Blob Hobby quotas |
| https://vercel.com/docs/postgres | Vercel Postgres discontinued; use Marketplace |
| https://neon.com/pricing | Neon Free plan limits |
| https://neon.com/docs/guides/vercel-overview | Neon–Vercel integration and preview branches |
| https://supabase.com/pricing | Supabase Free plan limits |
| https://orm.drizzle.team/docs/migrations | `push` vs `generate` + `migrate` |
| https://tiptap.dev/docs/editor/getting-started/install/nextjs | Tiptap Next.js setup |
| https://github.com/ueberdosis/tiptap | Tiptap MIT license; Pro extensions are paid |
| https://github.com/TypeCellOS/BlockNote | BlockNote MPL-2.0 core; GPL-3.0 `xl-*` packages |
| https://playwright.dev/docs/auth | Setup project and `storageState` pattern |
| https://vercel.com/docs/deployments/environments | Preview vs Production; per-branch environment variables |
| https://vercel.com/docs/plans/hobby | Hobby limits; non-commercial restriction |
| https://nextjs.org/blog/upcoming-nextjs-security-release-september-22-2026 | Next.js 16.3.6 security release |

These came from search results only and weren't fetched: Next.js 16.3 release (nextjs.org/blog/next-16-3), and a possible 16.3.7 security release scheduled for 2026-09-30. Treat both as **unverified**.

## 3. Topic 1: Google authentication and domain restriction

**Findings**
- The `hd` request parameter only optimizes the account picker. Google says: "Don't rely on this UI optimization to control who can access your app." The server must check that the ID token's `hd` claim matches the expected value (Google OIDC doc).
- The `hd` claim in the ID token "can be trusted" and is "provided only if the user belongs to a Google Cloud organization". Personal Gmail accounts don't have it. `email_verified` is a separate boolean claim (Google OIDC doc).
- Auth.js (NextAuth) has been maintained by the Better Auth team since 2025-09-22. It gets security patches only, and Better Auth is recommended for new projects (Better Auth blog).
- Better Auth's Google provider has an `hd` option. The docs say "Better Auth enforces the returned ID token/profile claim" and "Tokens with no `hd` claim are rejected whenever `hd` is configured." The examples accept only a single string, or `"*"` for any Workspace domain. If you supply a custom `getUserInfo`, it replaces the built-in `hd` check (Better Auth Google doc).
- Auth.js's example checks `profile.email_verified && profile.email.endsWith("@example.com")` in the `signIn` callback (Auth.js doc).
- OAuth audience: **Internal** requires a Google Cloud Organization and allows only that organization's members. **External** allows any Google account. In testing mode, External is limited to 100 test users. However, basic sign-in scopes (name, email, profile) don't need the test-user list and don't expire after 7 days (Google Cloud help).
- **Unverified:** how `hd` is reported when a user's email is on a *secondary* or alias domain of the Workspace org. This matters for P1.

**Conclusion (recommendation):** Use Better Auth's Google provider with `hd` set from an environment variable (for example `ALLOWED_GOOGLE_HD`). Add a defensive server-side check of `email_verified === true` and the email domain, in a Better Auth database hook or custom logic. No domain value goes in code.

**Risks**
- `hd` accepts a single string. If the user decides to allow more than one domain, that needs custom validation, which is more code and more risk.
- Choosing Internal requires Azumo's Google Cloud Organization admin access.

## 4. Topic 2: Frontend and backend

**Findings:** Next.js 16.x is the current major version. A critical out-of-band security fix shipped as 16.3.6 on 2026-09-22 (Next.js blog). The default Vercel Functions duration on Hobby is 300 s (Vercel limits).

**Options**
- **(A) Next.js App Router full-stack** (route handlers and server actions). This fits Vercel natively.
- **(B) Separate SPA plus API.** This means two deployables, which is overkill for 2–3 days.

**Conclusion:** Option A, pinned to the latest patched 16.3.x at scaffold time.

**Risk:** Next.js security releases are frequent, so plan to update the patch version.

## 5. Topic 3: Data persistence

**Findings**
- Vercel Postgres is no longer available. New projects use a Marketplace Postgres integration (Vercel docs).
- **Neon Free:** 0.5 GB per project (writes are blocked beyond that), 100 CU-hours per project per month, 10 branches, and scale-to-zero after 5 minutes that can't be disabled (Neon pricing). Both Neon–Vercel integrations auto-create a database branch per preview deployment (Neon doc).
- **Supabase Free:** 500 MB database, 1 GB file storage, 50 MB max upload, 2 active projects, and a pause after 1 week of inactivity (Supabase pricing).
- **Drizzle:** `push` is recommended for rapid prototyping. `generate` + `migrate` gives versioned migrations (Drizzle docs). Better Auth supports Drizzle, Prisma, and Kysely, and generates its schema via `npx auth@latest generate` (Better Auth docs).

**Conclusion:** Neon through the Vercel Marketplace, with Drizzle ORM. Use versioned `generate` + `migrate` from the start, which gives reviewers an audit trail. Keep `push` for local experiments only.

**Risks**
- After a scale-to-zero pause, the first request has a cold start. The size of this latency wasn't measured (**unverified**).
- Per-preview database branches mean migrations must run against each branch.

## 6. Topic 4: Content editor

**Options**

| Option | Facts | Trade-off for 2–3 days |
|---|---|---|
| Tiptap (StarterKit) | MIT core. Pro extensions (collaboration, comments, and more) need a subscription. Next.js setup needs `'use client'` and `immediatelyRender: false` to avoid hydration errors. | Flexible and headless, so you build the toolbar UI yourself (a few hours) |
| BlockNote | Built on ProseMirror/Tiptap. Core is MPL-2.0; `@blocknote/xl-*` packages are GPL-3.0 or need a commercial license. | Most Notion-like out of the box; avoid the `xl-*` packages |
| Lexical | Not researched in this pass (**unverified**) | — |
| Markdown textarea plus renderer | Simplest option | Weakest "Notion-inspired" demo |

**Conclusion:** BlockNote core if a Notion-like feel is the priority. Tiptap StarterKit if control and a minimal license surface matter more. Either way, store the editor JSON in a `jsonb` column.

**Risks**
- Any editor that stores HTML or JSON needs output sanitization before rendering outside the editor.
- A GPL `xl-*` package could slip in by accident.

## 7. Topic 5: Files (linking vs uploading)

**Findings**
- The request and response body limit of a Vercel Function is **4.5 MB**; larger payloads return 413 `FUNCTION_PAYLOAD_TOO_LARGE` (Vercel limits).
- Vercel Blob **client uploads** go directly from browser to Blob. The server must authenticate and authorize in `onBeforeGenerateToken`, otherwise "anyone can upload files to your Blob store". `onUploadCompleted` does not reach localhost; the docs suggest ngrok. `handleUpload` requires `BLOB_READ_WRITE_TOKEN` (Blob client-upload doc).
- **Private stores** are GA. Reads require authentication, and delivery goes through your own route via `get()`. Vercel recommends checking auth in the route handler rather than relying on middleware, and using `Cache-Control: private, no-cache`. The access mode can't be changed after the store is created (Blob docs).
- **Hobby Blob quota:** 1 GB storage, 10k simple operations, 2k advanced operations, 10 GB data transfer. If you exceed it, Blob is blocked for 30 days, with no charge (Blob pricing).

**Options**
1. **Links only.** No storage. Validate the URL scheme (https) on the server.
2. **Uploads.** Private Blob store, client uploads, and an authorizing download route.
3. **Both.**

**Permission enforcement (inference):** store the blob pathname in the database row that links the attachment to its page and workspace. Serve files only through a route like `/api/files/[attachmentId]`. That route loads the attachment, then the page, then the workspace, checks the requester's membership and role, and only then calls `get()`. Never show the raw blob URL to users. In `onBeforeGenerateToken`, check that the user can edit the target page (pass `pageId` via `clientPayload`), and set `allowedContentTypes` and a size cap.

**Risks:** the upload callback can't be tested locally without a tunnel, and the Hobby Blob quota is small.

## 8. Topic 6: Testing and deployment

**Findings**
- Playwright recommends authenticating once in a setup project and reusing `storageState`. Keep `playwright/.auth` out of git because it contains session cookies. The docs give no OAuth-specific guidance (Playwright docs).
- Better Auth's `testUtils` plugin provides `createUser`, `saveUser`, `login`, and `getCookies`. It adds privileged helpers, so the docs recommend a separate test-only auth instance and keeping it out of production (Better Auth test-utils).
- Google redirect URIs must match exactly. Wildcards are not allowed, and HTTPS is required except on localhost (Google web-server doc). Vercel creates per-commit and per-branch preview URLs, and supports per-branch Preview environment variables. A stable domain can be assigned to a preview branch on all plans (Vercel environments).

**Conclusion**
- Use Vitest for unit tests, especially the permission logic.
- Run integration tests against a Neon branch or local Postgres.
- Run Playwright E2E using test-only sessions from `testUtils`.
- Test real Google login manually on production, plus at most one stable preview domain.
- Don't try to run Google OAuth on per-commit preview URLs.

**Risks**
- Mocked auth doesn't prove SSO works, so a manual SSO check with recorded evidence is still needed.
- If the test auth instance leaks into production, it's a security hole.

## 9. Recommended stack (primary)

Next.js 16.3.x (App Router, TypeScript), Better Auth (Google provider with `hd` from an environment variable), Neon Postgres via the Vercel Marketplace, Drizzle ORM with versioned migrations, BlockNote core or Tiptap StarterKit, Vercel Blob in a private store with client uploads (only if P2 includes uploads), Vitest and Playwright, deployed on Vercel.

Better Auth's organization plugin supports multiple organizations per user and an active organization. Its default roles (owner, admin, member) are **not** the same as the proposed PR3 roles (Owner, Editor, Viewer). Mapping them needs custom access control, or you can write a small custom membership table.

## 10. Alternative stack

Next.js plus Supabase (Postgres, Auth with Google, and Storage in one service). This means fewer vendors and 1 GB of file storage, but the free project pauses after 1 week of inactivity. Supabase Auth's domain-restriction mechanics were **not researched** in this pass.

## 11. Accounts required

- A Google Cloud project with an OAuth client ID. Internal audience requires the Azumo Cloud Organization.
- A Vercel account or team (P4).
- A GitHub repository (P4).
- Neon, created through the Vercel Marketplace.
- A Vercel Blob store, only if uploads are chosen.

Secrets go only in Vercel and local `.env.local` files, never in the repository.

## 12. Compatibility notes

- Blob private storage needs `@vercel/blob` 2.3 or later.
- Tiptap and BlockNote are client-only in Next.js.
- A Better Auth custom `getUserInfo` disables the built-in `hd` check.
- Blob OIDC authentication works on Vercel. Locally it works after `vercel env pull`.

## 13. Limitations of this research

- Lexical and the Supabase Auth domain restriction were not researched.
- Secondary-domain `hd` behavior was not verified.
- Cold-start latency was not measured.
- Nothing was installed or run.

## 14. Estimated costs

On free tiers the cost is $0, within these limits:

| Service | Free-tier limit |
|---|---|
| Vercel Hobby | 1M function invocations, 4 active CPU-hours |
| Neon Free | 0.5 GB, 100 CU-hours per project |
| Blob Hobby | 1 GB |

**Caveat:** Vercel Hobby is restricted to "non-commercial, personal use only" (Vercel Hobby doc). Pro costs $20 per developer seat per month. Whether an internal Azumo prototype counts as commercial is for the user or Azumo to determine. Other quotas may change; check them at provisioning time.

## 15. Impact on open decisions P1–P4 (informational, not decided)

- **P1:** Better Auth's `hd` takes one string. Allowing one domain is config-only. Allowing more than one requires custom code, and depends on whether `azumo.com` and `azumo.co` are one Workspace org (primary/secondary domain) or separate orgs, which is unverified. Internal audience only works if both domains are in the same Cloud Organization.
- **P2:** Links only means no Blob store, no 4.5 MB concern, and less time. Uploads add a Blob store, an auth-checked token route, an authorizing download route, and quota limits.
- **P3:** Section 9 is a recommendation only. The user approves.
- **P4:** The Hobby plan's non-commercial clause, and who owns the Google OAuth client and redirect URIs, depend on which account and team is authorized.

## 16. Open questions for the user

1. Are `azumo.com` and `azumo.co` in the same Google Workspace/Cloud organization, and do you have admin access to it?
2. Should the OAuth audience be Internal (needs org admin) or External?
3. For files: links, uploads, or both? If uploads, what maximum size and which file types?
4. Should the prototype be deployed on a personal Hobby account or an Azumo Pro team?
5. Do you prefer a Notion-like editor out of the box (BlockNote) or a minimal, fully controlled one (Tiptap)?
6. Is a stable preview/staging domain with Google login needed, or is production-only SSO testing acceptable?
