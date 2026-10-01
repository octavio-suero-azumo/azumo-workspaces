# Azumo Workspaces

A Notion-inspired prototype for the Azumo Bench Challenge:
- Google sign-in restricted to one corporate domain.
- Multiple workspaces, with per-workspace roles (Owner / Editor / Viewer).
- Pages with basic rich text.
- File attachments stored in a private Vercel Blob store.

Stack: Next.js 16 (App Router, TypeScript), Better Auth (Google only), Drizzle ORM, PGlite for local development and tests, Neon Postgres in production, Tiptap editor, Vercel Blob.

Project documents live in `docs/`: [PRD](docs/PRD.md), [architecture](docs/architecture.md), [test plan](docs/test-plan.md), [traceability](docs/requirements-traceability.md), [status log](docs/status.md), [deploy runbook](docs/deploy-runbook.md).

## Requirements

- **Node.js 22** (`.nvmrc`). The project needs Node ≥ 20.9.
  - On Apple Silicon, make sure the active Node is an arm64 build.
  - An old x86_64 Node (for example Node 14 installed for Intel) fails with `Bad CPU type in executable`.
  - Run `nvm use` in the project folder, or `nvm alias default 22`.
- **npm**, using the committed `package-lock.json`.

## Run locally

```bash
nvm use
npm ci
npm run dev
```

Then open http://localhost:3000. Without a session, every app page redirects to `/sign-in`.

**Claude Desktop:** the preview configuration `.claude/launch.json` (`azumo-dev`) attaches to a server already running on port 3000. It doesn't start the server itself: when the preview panel spawned it, Turbopack's helper process failed with "Bad CPU type" on this machine. Start the server first with `npm run dev`.

### Environment variables (`.env.local`, gitignored)

`.env.example` lists every name. Values are never committed.

| Variable | Needed for | Notes |
|---|---|---|
| `ALLOWED_GOOGLE_HD` | Starting the app | The single allowed Google Workspace domain. Decided: `azumo.co`. The meeting notes mentioned `azumo.com`; this discrepancy is recorded, and only `azumo.co` is enabled. |
| `BETTER_AUTH_URL` | Sign-in | `http://localhost:3000` locally. Must be `https://` in production. |
| `BETTER_AUTH_SECRET` | Sign-in | A random string of 32 characters or more. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Sign-in | A Google OAuth client of type "Web application". |
| `DATABASE_URL` | Production | Leave empty locally to use PGlite in `.pglite/`. |
| `DATABASE_URL_UNPOOLED` | Production migrations | Read only by `npm run db:migrate:prod`. |
| `BLOB_READ_WRITE_TOKEN` | Uploads | Token of a **private** Vercel Blob store. Without it, uploads show "not configured" and the rest of the app works. |
| `UPLOAD_MAX_BYTES`, `UPLOAD_ALLOWED_TYPES` | Optional | They default to the approved limits: 10 MB; PDF, images, text, CSV and Office files. |

**Google OAuth client (local):**
- Authorized JavaScript origin: `http://localhost:3000`
- Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
- If the consent screen is in "Testing" status, add every account you sign in with as a test user.

### Database

- **Local:** PGlite (embedded Postgres, no external service). The versioned migrations in `drizzle/` are applied automatically the first time the app opens `.pglite/`. `npm run db:migrate:local` applies them explicitly; stop `npm run dev` first, because PGlite allows only one process.
- **Production:** Neon, through the Vercel Marketplace. Use `npm run db:migrate:prod`; it refuses to run without a URL and never falls back to PGlite. Follow [docs/deploy-runbook.md](docs/deploy-runbook.md).

The migrations only add tables and constraints.

## Checks

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e        # dev server; Playwright Chromium required
npm run test:e2e:prod   # same suite against next build + next start
npm run build
```

The project MCP server `bench` (`tools/bench-mcp`, registered in `.mcp.json`) runs these checks with timeouts and stores reports in `docs/bench/runs/`.
- A suite that discovers no tests is reported as `no_tests`, never as passed.
- Tests for the server itself: `npm run test:mcp`.

## Verification status (2026-09-30)

**Passed, automated** (latest run: lint, typecheck, 408 unit, 539 integration, 43 E2E, build):
- The domain rule (`hd` + `email_verified`), checked at user creation, at session creation and on every request.
- Server-side authorization with per-workspace roles, and isolation between workspaces, including forged-ID and replayed-request attacks.
- Page create, edit and delete, with persistence after reload.
- Upload authorization, and the download route's headers (`attachment`, `private, no-cache`, `nosniff`).

The E2E tests and the rules above use **simulated** Google sessions (a test-only helper with no HTTP route) and a **mocked** Blob SDK. They do not prove the real integrations.

**Passed, manual local check:**
- The dev server starts.
- `/` and app routes redirect to `/sign-in` without a session.
- `/sign-in` renders.
- With no Google credentials, the auth endpoints fail closed.

**Pending, blocked by configuration:**
- Real Google sign-in with an allowed account, and rejection of an external account. Needs the OAuth client credentials in `.env.local` and test accounts.
- Real upload and download with Vercel Blob. Needs a private Blob store token.
- Anything against Neon, and the Vercel deployment. Needs a Vercel project, which does not exist yet; see the runbook.
