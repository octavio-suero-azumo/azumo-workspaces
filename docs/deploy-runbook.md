# Deploy runbook — Azumo Workspaces

Status: **preparation only.** Nothing here is authorized until the user approves P4 (Vercel account and repository), P10 (Vercel plan) and the deploy itself. Every secret goes straight into the Vercel or Google console. Secrets never go in chat, in the repository or in a command line.

Roles:
- **User** works in the web consoles (Vercel, Neon, Google Cloud). Steps marked **[User]** are clicks.
- **Coordinator** runs local commands. Steps marked **[Coordinator]** are commands.

Source reviews: RV-F-01 (migration path), RV-F-02 (no real Neon run yet), RV-F-04 (large downloads), RV-F-07 (https). See `docs/reviews/increment-DEF-predeploy.md`.

---

## 1. Prerequisites

| # | Item | Where | Notes |
|---|---|---|---|
| 1.1 | **P4:** the authorized Vercel account or team, and the authorized Git repository | Vercel dashboard | Import the repo: **Add New… → Project → Import Git Repository**. Framework preset: Next.js. Settings → General → Node.js Version: **22.x**. |
| 1.2 | **Neon Postgres** via Vercel Marketplace | Vercel project → **Storage → Create Database → Neon** | Connect it to the project. This injects `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct), plus some `PG*` variables. Pick the region closest to the Function region (Settings → Functions → Region). For previews, see §2.2. |
| 1.3 | **Private** Vercel Blob store | Vercel project → **Storage → Create → Blob** | Access: **Private**. This can't be changed later. Connect it to **Production only** (§2.2). This injects `BLOB_READ_WRITE_TOKEN`. |
| 1.4 | **Google OAuth client** (Web application) | Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client ID** | *Authorized JavaScript origins:* `${BETTER_AUTH_URL}`. *Authorized redirect URIs:* exactly `${BETTER_AUTH_URL}/api/auth/callback/google`. `BETTER_AUTH_URL` is the production URL, for example `https://<project>.vercel.app` or the custom domain. Use https and no trailing slash. Copy the client ID and secret straight into Vercel (§2). |
| 1.5 | **OAuth consent screen** | Google Cloud Console → **Google Auth Platform** → Branding / Audience / Data access | Scopes: `openid`, `email`, `profile` only. **Audience (P9, open):** **External** is the default plan; the domain is enforced by the app (`hd` + `email_verified`). Use **Internal** only if the project belongs to the Google Workspace organization of the authorized domain. **Publishing status "Testing":** only accounts listed under **Test users** can sign in; Google itself blocks everyone else before the app runs. See the note in §5 (TC-41, TC-42). |
| 1.6 | Test accounts for §5 | User | Two accounts on the authorized domain (A, B). One Google Workspace account on another domain. One personal Gmail account. This is an open decision (RV-F-12). |

---

## 2. Environment variables (names only)

Set these in Vercel → project → **Settings → Environment Variables**. Mark secrets as **Sensitive**. Never decrypt or print values.

### 2.1 Production

| Variable | Source | Required | Notes |
|---|---|---|---|
| `DATABASE_URL` | Neon integration (automatic) | Yes | Pooled endpoint. The app uses it (`prepare: false`, pool `max 3`). |
| `DATABASE_URL_UNPOOLED` | Neon integration (automatic) | Migrations only | Direct endpoint. Only `db:migrate:prod` reads it; the app never does. |
| `BETTER_AUTH_SECRET` | User (Sensitive) | Yes | At least 32 random characters, from a password manager's generator. Use a different value per environment. |
| `BETTER_AUTH_URL` | User | Yes | The exact production origin. **Must be `https://`**; the app refuses to start otherwise (RV-F-07). |
| `GOOGLE_CLIENT_ID` | User | Yes | From 1.4. |
| `GOOGLE_CLIENT_SECRET` | User (Sensitive) | Yes | From 1.4. |
| `ALLOWED_GOOGLE_HD` | User | Yes | The single domain decided in P1 (PRD header). Lowercase, no wildcard, no list. |
| `BLOB_READ_WRITE_TOKEN` | Blob integration (automatic) | Yes (uploads) | From 1.3. |
| `UPLOAD_MAX_BYTES` | — | No | Leave **unset**: the default is the approved P8 value (10 MB). Changing it needs user approval. |
| `UPLOAD_ALLOWED_TYPES` | — | No | Leave **unset**: the default is the approved P8 list. |
| `ENABLE_TEST_AUTH` | — | **Must not exist** | Not in any Vercel environment. The app refuses to start with it in production. |
| `PGLITE_DATA_DIR` | — | Must not exist | Local development only. |

`VERCEL` and `VERCEL_ENV` are system variables set by Vercel; do not create them. When `VERCEL` is set, the app **refuses** to run without `DATABASE_URL` and never falls back to local PGlite (RV-F-06).

### 2.2 Preview

P11 says SSO is verified in production only, so Google sign-in is **not** expected to work on previews: the preview URL isn't a registered redirect URI.

| Variable | Setting |
|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Only from a **Neon preview branch**: in the Neon integration settings, enable a branch per preview deployment. Never point previews at the production database. Without a URL, preview deployments fail closed (500) by design. |
| `ALLOWED_GOOGLE_HD` | Same value as production. The app refuses to start without it. |
| `BETTER_AUTH_SECRET` | A value different from production. |
| `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Not needed (no preview SSO). |
| `BLOB_READ_WRITE_TOKEN` | **Not set.** Don't connect the production Blob store to Preview. Uploads then show "not configured". |
| `ENABLE_TEST_AUTH` | Must not exist. |

---

## 3. Database migrations (before the app goes live)

Migrations are the versioned SQL files in `drizzle/`. They are applied by `scripts/migrate.mjs`:

| Command | Target |
|---|---|
| `npm run db:migrate:prod` | `DATABASE_URL_UNPOOLED` (preferred) or `DATABASE_URL`. **Refuses** if neither is set. Never uses PGlite. Prints only host/database. `-- --dry-run` prints the target without connecting. |
| `npm run db:migrate:local` | Local PGlite, explicitly. Refused when `VERCEL` is set. |
| `npm run db:migrate` | Remote when a URL is set, otherwise refuses. |

Order, for the first deploy and for every deploy that adds a migration:

1. **[User] Back up.** In the Neon console (Vercel → Storage → the database → **Open in Neon**), go to **Branches** and create a branch from the production branch, named for example `backup-before-<date>`. This is the restore point.
2. **[User] Provide the direct URL without pasting it anywhere.** In the Neon console, go to **Connection details**, turn **Connection pooling off** and copy the string. With a text editor, create the file `.env.migrate.local` in the project root with one line: `DATABASE_URL_UNPOOLED=<paste>`. The file is gitignored (`.env*`).
3. **[Coordinator] Dry run.** Run `node --env-file=.env.migrate.local scripts/migrate.mjs --target=prod --dry-run`. Show the user the printed `host/database` and migration list. **The user confirms** it is the intended production database. Never `cat` the file.
4. **[Coordinator] Apply.** Run `node --env-file=.env.migrate.local scripts/migrate.mjs --target=prod`. Expect exit code 0 and "Migrations applied". It is idempotent: already-applied migrations are skipped.
5. **[User]** Delete `.env.migrate.local`.
6. Only now deploy or promote (§4).

**RV-F-02 (blocking before production):** run steps 2–4 once against a **Neon dev branch** first, and do a smoke test of the app against that branch. No code has run against real Neon yet.

---

## 4. Deploy and promote

Deploying requires the user's explicit authorization for that specific action.

- **First deploy:** migrate (§3), then **[User]** Deployments → **Redeploy**, or the coordinator pushes to the production branch if authorized.
- **Later deploys with new migrations:** migrate **before** the new code serves traffic. Recommended: Settings → Environments → Production → turn **off** automatic assignment of the production domains (the label may vary, e.g. "Auto-assign Custom Production Domains"). A production build is then staged, not live. Run §3. Then Deployments → that deployment → **⋯ → Promote**.
- Keep migrations additive (new tables and columns), so the previous deployment keeps working if you roll back.

---

## 5. Post-deploy manual checks (from `docs/test-plan.md` §6.7)

Record evidence for each check: screenshots, deployment ID, commit SHA. Don't decrypt env values.

| ID | What to do | Pass if |
|---|---|---|
| TC-38 | Open the production URL. In Vercel → Deployments → the production deployment, check the repository, branch and **commit SHA**. | App served from the authorized repository and commit. |
| TC-39 | Settings → Environment Variables: confirm `ENABLE_TEST_AUTH` is **not listed** for any environment. On `/sign-in`, only "Sign in with Google" exists. Optionally the coordinator POSTs to `/api/auth/sign-in/email`. | Not listed. Email/password rejected. Google only. |
| TC-40 | Account A (authorized domain, listed test user if "Testing"): sign in, reach `/`, sign out, then press Back or reload. | Session created, then invalidated. |
| TC-41 | Sign in with a Workspace account on **another** domain. | Rejected by the app. No `user`/`session` row (read-only check in Neon's SQL editor). |
| TC-42 | Sign in with a **personal Gmail** account. | Rejected. No rows. |
| TC-43 | Smoke test. (1) Signed out, open `/` → redirected to `/sign-in`. (2) A creates a workspace and a page, then uploads a small PDF and downloads it. (3) **RV-F-04:** A uploads a **~9 MB** file of an allowed type (PDF/PNG) and downloads it. The downloaded size must equal the original. (4) B opens A's page URL. (5) A deletes an attachment, and its old download link no longer works. | Everything works. B is denied (404). After deletion the file is unavailable. If step 3 fails (e.g. 413, 500, `FUNCTION_PAYLOAD_TOO_LARGE` in the runtime logs), record it and escalate. **Lowering P8 needs user approval.** |

**TC-41/TC-42 with "Testing" status:** Google blocks unlisted accounts itself ("access blocked"), so the app's `hd` guard is never exercised. To prove the **app** rejects them, add those two accounts as **Test users**, or publish the app, before the test. Record which one was done.

Also check Vercel → project → **Logs** during the checks: no 500s and no configuration errors.

---

## 6. Rollback

| Problem | Action |
|---|---|
| Bad app release | **[User]** Vercel → Deployments → the last good production deployment → **⋯ → Instant Rollback** (or **Promote**). Safe when migrations were additive. |
| Bad migration or data | **[User]** Neon console → **Branches** → restore the production branch from the `backup-before-<date>` branch, or use point-in-time restore within the plan's history window. Then roll the app back to the matching deployment. Drizzle migrations are forward-only: there is no automatic "down". |
| Leaked secret | Rotate it in the source console (Google client secret, `BETTER_AUTH_SECRET`, Neon password, Blob token). Update the Vercel env var, then redeploy. Rotating `BETTER_AUTH_SECRET` signs everyone out. |
| Orphan blobs after failures | Accepted residual risk (RV-F-09, RK-5). Clean up manually in Vercel → Storage → Blob if needed. |

---

## 7. Known open items

- P4, P9, P10, deploy authorization and test accounts are still open (RV-F-12).
- RV-F-02: no run against real Neon yet (see §3).
- RV-F-04: whether a ~9 MB streamed download passes through a Function (TC-43, step 3).
- Connection-string parameters: postgres-js honours `sslmode` from the URL, but `sslmode=require` encrypts **without** verifying the certificate. postgres-js may also forward libpq-only parameters such as `channel_binding` to the server as startup parameters. Check both during the RV-F-02 smoke test on the Neon dev branch.
