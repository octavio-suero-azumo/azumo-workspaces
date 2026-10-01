# Implementation plan: Azumo Workspaces (first iteration)

- **Status:** APPROVED (2026-09-29, user consolidated approval). §00 is the operative schedule.
- **Origin:** drafted by `architect` (agentId `af8ceef86d036f86e`). The coordinator then applied the `developer` feasibility review (agentId `a3a693434ca2730c9`, §5) and the `reviewer` observations (agentId `a945a6d5953ce518b`). All on 2026-09-29. Every change is listed in §7.
- **Global gates for every T-task:** PRD and plan approved, P3 approved, and the user authorizes that specific task or batch. Installing packages needs separate authorization. No commits, pushes or deploys without specific authorization.
- **Sizes:** S ≤ 2 h, M ≤ 4 h (ceilings). AC IDs are in `docs/PRD.md` §10, the design in `docs/architecture.md`, and the test cases in `docs/test-plan.md`.

## 00. Accelerated 2-day schedule (v3, 2026-09-29): pending the consolidated approval

This section overrides §0 and §4 where they conflict. PR1–PR3 are approved (see PRD §0). **P1 = `azumo.co`** and **P2 = uploads** (decided 2026-09-29). T-14 (links) is dropped. T-15 and T-16 are in scope. Uploads add about half a day.

| Increment | Tasks | Day | Checked by |
|---|---|---|---|
| A. Runnable base + checks | T-01, T-02, **B-MCP** (`tools/bench-mcp`) | Day 1 AM | `run_checks`: lint, typecheck, unit, build |
| B. Auth and session | T-03a, T-06a, T-06b, T-07 | Day 1 AM/PM | Unit tests for the guard; integration tests for no-session access |
| C. Workspaces, members, authorization | T-03b, T-03c, T-04, T-05, T-08, T-09 | Day 1 PM | Integration tests: matrix, isolation, multi-workspace roles |
| D. Pages and editor | T-10, T-11, T-12 | Day 2 AM | Integration tests plus E2E persistence |
| E. Uploads | T-13, T-15, T-16 | Day 2 AM/PM | Integration tests with Blob mocked (**simulated**). A real upload and download needs a Blob store token, which **depends on P4**. |
| F. Validation and deploy prep | T-17a, T-17b, T-18\*, T-19\*, T-20 | Day 2 PM | Full suite, `next build`, reviewer; \*T-18 and T-19 need P4, P1 and deploy authorization |

**Honest viability note:** the S/M ceilings in §0 sum to about 50 h. Two days only work because each task's code is agent-generated, which puts real task time well below the ceiling. The parts that are **not** in the coordinator's hands are:
- the Google OAuth client;
- the P1 domain;
- the Vercel account and repository (P4);
- the deploy authorization;
- the test accounts for TC-40 to TC-42.

If those arrive late, the app will be finished and verified locally, but AC-02 to AC-04, AC-33 and AC-35 will be reported as **not verified**, not as passed.

**Process to cut time:**
- Each task goes to developer, then the coordinator runs the checks for real through the MCP.
- qa writes and runs the tests per increment, not per task.
- reviewer reviews once for security at the end of C (authorization) and once at the end of F.
- At most 2 correction cycles per task.

### B-MCP: `tools/bench-mcp` (replaces §4)

- **What it is:** a local stdio server registered in the project `.mcp.json`. It is not a generic framework.
- **Tools:**
  - `get_requirements`: reads R/AC from `docs/PRD.md`.
  - `list_tasks`: reads tasks from a JSON task store.
  - `upsert_task`: creates or updates a task in that store. It **refuses `status: done` unless the task has at least one linked passing run report with discovered tests greater than 0**.
  - `run_checks`: runs only these predefined checks: `lint`, `typecheck`, `unit`, `integration`, `e2e`, `build`. Each runs with a timeout and inside the workspace only. Arbitrary commands are not accepted.
  - `get_run_report`: returns the stored report of a run.
- **Stored results:** exit code, duration, test counts, and a status of `passed` / `failed` / `error` / `timeout` / `no_tests`. A report with 0 discovered tests is `no_tests`, never `passed`. Output excerpts are redacted of anything that looks like a secret.
- **How it is tested:** unit tests, plus real invocations recorded in `docs/status.md`.

## 0. Estimate vs the 2–3 day target (P12, open)

| Scope | Ceiling (sum of S/M ceilings) |
|---|---|
| Mandatory core (13 S + 5 M: every task except T-11 to T-16 and MCP) | 46 h |
| + files, links only (T-13, T-14) | +4 h (total 50 h) |
| + files, uploads only (T-13, T-15, T-16) | +8 h (total 54 h) |
| + files, both (T-13 to T-16) | +10 h (total 56 h) |
| + PR1/PR2 (T-11, T-12) | +6 h |
| + minimal MCP (M-01 to M-03) | +8 h |

2–3 working days is about 16–24 h. The ceilings are **2–3 times** that. The target is only realistic if tasks come in well under their ceilings, or if scope is cut. This is a **real risk and a decision for the user (P12)**. The cheapest levers are:
- Choose links only for P2.
- Defer PR1/PR2 (T-11, T-12).
- Defer MCP until after T-19.
- Drop DP10 (rename).

## 1. Tasks (in execution order)

| ID | Goal | Depends on (tasks / decisions) | Files / areas | ACs | Size |
|---|---|---|---|---|---|
| T-01 | Scaffold Next.js + TypeScript, lint, Vitest, Playwright config, `.gitignore`, `.env.example` (names only). Check whether Next 16 uses `middleware.ts` or `proxy.ts` | P3; install authorization; `git init` authorization; decision on RV-17 (see §3) | repo root, configs | AC-34 (partial) | S |
| T-02 | `env.ts` typed validation, fail-closed on `ALLOWED_GOOGLE_HD`, plus unit tests. A separate env profile for schema generation | T-01 | `src/server/env.ts` | AC-06 | S |
| T-03a | Minimal Better Auth config (Google provider only, `emailAndPassword` off, cookie cache off). Generate the auth tables. Pin the ID and column-name strategy | T-02; DP9 | `src/server/auth`, `src/server/db`, `drizzle/` | AC-36 (config part) | S |
| T-06a | Domain guard: `hd` from env, runs before user **and** session creation, spike on where `hd` is available (`mapProfileToUser`), unit tests for the pure guard. The code works with any domain value (placeholder `allowed.test`) | T-03a; DP1. **Manual Google verification blocked by P1 and P9.** Email-domain check pending P1 | `src/server/auth` | AC-02 to AC-05 | M |
| T-06b | `/sign-in` and sign-out, optimistic redirect (middleware/proxy), `requireSession()`, `action()` wrapper plus a static check | T-06a | `src/app/sign-in`, `src/server/authz`, `middleware.ts`/`proxy.ts` | AC-01, AC-07 | S |
| T-07 | Test-only auth module (no HTTP route), Playwright global setup writing `storageState`, guard unit test | T-06b; DP8 | `tests/setup`, `src/server/auth/test-auth.ts` | AC-36 | S |
| T-03b | Migration for `workspace`, `membership` and `page` (composite unique key on `page`) | T-03a; role CHECK values **blocked by PR3** | `src/server/db`, `drizzle/` | AC-14 | S |
| T-03c | Test DB harness: `TEST_DATABASE_URL`, fixtures from test-plan §2, per-test reset | T-03b, T-07 | `tests/fixtures`, `tests/setup` | (enables all I/E2E cases) | S |
| T-04 | `permissions.ts` matrix and `can()` with a unit test per cell | T-01; **blocked by PR3**; DP5, DP10 | `src/server/authz/permissions.ts` | AC-15 (unit) | S |
| T-05 | `authorize()` with targets workspace/page/attachment/membership; error→HTTP mapping; scoped data-layer pattern; integration tests | T-03c, T-04, T-06b; DP2 | `src/server/authz`, `src/server/http.ts`, `src/server/data` | AC-10, AC-11, AC-12, AC-38 | M |
| T-08 | Workspaces: create, list mine, switch (rename only if DP10), app shell | T-05; **blocked by P5** | `src/server/data/workspaces.ts`, `src/app/(app)` | AC-08, AC-09, AC-13, AC-37 | M |
| T-09 | Members: list, add, change role, remove; conditional last-Owner guard | T-08; **blocked by PR3 and P6**; DP3 | `src/server/data/members.ts`, members UI | AC-16, AC-17 | M |
| T-10 | Pages: create, list, view. Plain-text content set at creation | T-08; **A1 confirmed** | `src/server/data/pages.ts`, page routes | AC-19, AC-20, AC-18 (partial) | M |
| T-13 | `attachment` migration (composite FK, `kind` CHECK per P2) and attachment list | T-10; **blocked by P2** | `src/server/db`, `attachments.ts` | AC-25, AC-20 | S |
| T-14 | Link attachments: add and delete | T-13; **only if P2 ∈ {link, both}**; DP6 | `attachments.ts`, page UI | AC-21, AC-26 | S |
| T-15 | Upload: private Blob store, token route with pathname-prefix validation, `registerUpload` | T-13; **only if P2 ∈ {upload, both}; blocked by P8 and P4**; Blob store creation authorization | `src/app/api/uploads`, `attachments.ts` | AC-22, AC-23 | M |
| T-16 | Upload: authorizing download route (RFC 6266), delete with `del()` | T-15; DP7 | `src/app/api/files/[attachmentId]` | AC-24, AC-26 | S |
| T-11 | Page edit with a formatted editor and persistence | T-10; **blocked by PR1, PR2 and P7** | editor component, `pages.ts` | AC-27, AC-29, AC-30 | M |
| T-12 | Page delete with cascade | T-10; **blocked by PR1**; DP4, DP5 | `pages.ts`, page UI | AC-28 | S |
| T-17a | E2E/integration security suite, part 1: cross-workspace isolation and ID substitution | T-09 to T-16 as applicable; test-writing authorization | `tests/e2e`, `tests/integration` | AC-10, AC-11, AC-37, AC-38 | S |
| T-17b | Security suite, part 2: role × action and UI visibility | T-17a | `tests/e2e`, `tests/integration` | AC-15, AC-18 | S |
| T-18 | Vercel project, Neon integration, env vars, production DB migrations | T-17b; **blocked by P4, P10 and P11**; external resource authorization | Vercel/Neon consoles (no secrets in the repo) | AC-33, AC-34 | S |
| T-19 | Production deploy and manual SSO verification with evidence | T-18; **blocked by P1, P4 and P9**; deploy authorization; test accounts (§3) | `docs/status.md` (evidence) | AC-33, AC-35, AC-36 | S |
| T-20 | Final reviewer pass: compliance, permissions, secrets, traceability | T-19 | read-only | AC-31, AC-32, AC-34 | S |

The coordinator meets process ACs AC-31 and AC-32 continuously through `docs/status.md`.

**What can proceed before P1, P2, P4 and PR\* are resolved** (once P3 and the plan are approved): T-01, T-02, T-03a, T-06a (code), T-06b, T-07, and T-03b except the role CHECK.
**Blocked:** T-04 and T-09 (PR3), T-08 (P5), T-10 (A1), T-13 to T-16 (P2), T-11 and T-12 (PR1, PR2), T-18 and T-19 (P1, P4, P9 to P11).

## 2. Proposed first task: T-01

**Why T-01:** every other task depends on it. Of the open decisions it depends only on P3, and it doesn't touch P1, P2, P4 or any PR/DP. It can be verified objectively: install, lint, type-check, an empty Vitest run and `next build` all succeed, and a secret-pattern search is clean. It's small (S).

**Before starting it:**
1. Approve the PRD and this plan.
2. Approve P3.
3. Authorize installing dependencies.
4. Authorize `git init`.
5. Decide on RV-17 (§3).

## 3. Inputs the user must provide, and by when

| Input | Owner | Needed by |
|---|---|---|
| PRD + plan approval; confirmation of A1 | User | T-01 (A1: T-10) |
| P3 stack approval; install authorization; `git init` authorization | User | T-01 |
| RV-17: add `.claude/settings.json` with deny/ask rules for commit, push, deploy and install, **or** explicitly accept the risk | User | T-01 |
| PR3 (roles) and DP5/DP10 | User | T-03b (CHECK), T-04 |
| P5 (workspace creation) | User | T-08 |
| P6 (adding members) | User | T-09 |
| P2 (files) and, if uploads, P8 | User | T-13 / T-15 |
| PR1, PR2, P7 | User | T-11, T-12 |
| Google OAuth client and P9 (audience, owner); Azumo admin if Internal | User / Azumo admin | T-06a manual check, T-19 |
| P1 (domain) and whether `azumo.com`/`azumo.co` are in the same organization | User | T-19 (final configuration) |
| P4 (Vercel account/repo), P10 (plan), P11 (preview SSO) | User | T-15 (uploads), T-18 |
| Test accounts: one authorized, one Workspace account from another domain, one personal Gmail | User (unassigned) | T-19 |
| P12 (scope vs time) | User | Before T-01, ideally |

## 4. Minimal MCP phase (after T-19)

**The project MCP server does not exist yet.** It will be implemented only after this plan is approved, and it is scheduled after T-19 (RV-14) unless the user reorders it. It is a coordinator tool, not a deliverable (CLAUDE.md rule 8). It is **read-only**: it parses `docs/*.md` and never edits files, runs commands or deploys.

### Tools (minimal version)

| Tool | Input | Output | Problem it solves for the coordinator |
|---|---|---|---|
| `get_status` | none | Current phase, last N entries and open blockers from `docs/status.md` | Consistent state recovery at session start |
| `list_decisions` | optional `status` | P*, PR*, DP*, A* and proposed ACs, with open/resolved state and a confirmation reference | Prevents treating a proposal as approved, or an open decision as resolved |
| `check_task_ready` | `taskId` | `ready`, or `blocked` with the unmet task dependencies and unresolved P/PR/DP/A items | Stops the coordinator from launching a blocked task |

Deferred to a later iteration (RV-14): `get_task`, `get_traceability`, `check_task_coverage`, `find_gaps`.

### Tasks

| ID | Goal | Depends on | Verification | Size |
|---|---|---|---|---|
| M-01 | Freeze the markdown table formats (plan, status, PRD §5–6) and add fixture copies | Plan approved | Fixtures parse, and a format-contract test passes | S |
| M-02 | Stdio TypeScript server under `tools/mcp/` with the 3 tools | M-01; install authorization | Vitest unit tests on fixtures (at least one per tool, including ready and blocked cases). A test checks no tool writes files | M |
| M-03 | Register it in the project `.mcp.json` (user approval required), then run a manual smoke test in Claude Code | M-02 | `/mcp` lists the 3 tools. Each is called once against the real `docs/`, with the output recorded in `status.md` | S |

**How the coordinator will use it:**
- At session start: `get_status`.
- Before delegating a task: `check_task_ready`.
- Before asking the user to approve anything: `list_decisions`.

Until M-03 is verified, no agent or skill may assume these tools exist.

## 5. Feasibility review (developer)

- **Agent:** `developer` (real invocation: yes, agentId `a3a693434ca2730c9`), 2026-09-29. Analysis only: the agent used only Read, and changed no files and installed nothing. It reported that Grep and Glob were **not available** to it, even though they are in its definition.
- **Verdict:** feasible, with three issues. There is a T-03/T-05/T-06 cycle, no task owns the test DB, and the budget is unrealistic. All three are now handled in §0, §1 and T-03c.
- **Formatting:** the coordinator condensed this section from the agent's output. It is not verbatim.

### 5.1 Dependencies (versions: latest patched at scaffold time)

**Runtime**
- `next` (16.3.x with the 16.3.6 security fix or later), `react`, `react-dom`
- `better-auth`
- `drizzle-orm` plus a Postgres driver (`@neondatabase/serverless` or `postgres`; see RK-7)
- `zod`

**Dev**
- `typescript`, `@types/*`
- `eslint`, `eslint-config-next`
- `drizzle-kit`, `vitest`, `@playwright/test`
- Better Auth CLI (confirm the package name)

**Only if certain decisions go that way**
- Uploads (P2): `@vercel/blob` 2.3 or later.
- PR2 + P7 = BlockNote: `@blocknote/core`, `@blocknote/react` and one UI package (not researched). Never any `@blocknote/xl-*`.
- PR2 + P7 = Tiptap: `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`. No Pro extensions.
- MCP: `@modelcontextprotocol/sdk`.

### 5.2 Local tools

- **Node:** the minimum Next 16.3 documents (believed to be 20.9 or later; to verify).
- **Package manager:** npm, unless decided otherwise.
- **Postgres for tests:** local Postgres (Homebrew or Docker) recommended.
- **Vercel CLI:** for T-15 and T-18.
- **Playwright Chromium:** a binary download, so it needs authorization.
- **ngrok:** not needed.
- **git:** the project folder is **not a git repository yet**.

### 5.3 Risks (renamed RK-x to avoid confusion with requirements R1–R6, per RV-11)

| # | Risk | Likelihood / impact | Mitigation (where it's covered) |
|---|---|---|---|
| RK-1 | The `user.create.before` hook doesn't see `hd`. Returning users skip user creation. TC-01–03 need a mocked Google token endpoint. | Medium / High | T-06a: guard before user and session creation, spike, pure guard unit-tested, TC-01–03 labeled simulated |
| RK-2 | The Better Auth CLI imports the config (fail-closed env). Default ID types don't match the design. | Medium / Medium | T-02 (generation env profile), T-03a (pin the ID strategy) |
| RK-3 | Composite FK and CHECK constraints in Drizzle | Low / Medium | Review the generated SQL; TC-23 |
| RK-4 | Editor client-only rendering, read-only view, JSON normalization | Medium / Medium | T-11; AC-29 reworded |
| RK-5 | Local Blob needs a real store; orphan blobs | Medium / Medium | T-15; accept orphans for the prototype |
| RK-6 | Test-auth ending up in production | Medium / High | T-07 with no route; AC-36; TC-08, TC-39 |
| RK-7 | Neon HTTP driver without interactive transactions; cold start | Medium / Medium | Conditional-statement guard (architecture §4.10); local Postgres for tests |
| RK-8 | Time budget | High / High | §0 and P12 |

## 6. Suggestions not applied, and why

| Suggestion | Source | Decision |
|---|---|---|
| Merge T-06 with T-07 | RV-14 | Not applied: the developer judged T-06 already too large and it was split into T-06a/T-06b; merging again would exceed half a day. |
| Merge T-13 with T-14 | RV-14 | Not applied: T-13 is needed for any P2 option, and T-14 only for links. |
| `get_task`, `get_traceability`, `check_task_coverage`, `find_gaps` in the MCP | Architect | Deferred per RV-14, to stay within the budget. |
| RV-17 (`.claude/settings.json`) | Reviewer | Not applied: it changes the project's persistent configuration, which was not authorized in this phase. It goes to the user (§3). |

## 7. Coordinator changes after review (2026-09-29)

| Change | Source |
|---|---|
| Removed the T-03/T-05/T-06 cycle: new order with T-03a, T-06a/b, T-03b | Developer inconsistency 4, RV-04 |
| New T-03c (test DB harness and fixtures) | Developer, RV-04 |
| T-06 split, T-17 split | Developer, RV-14 |
| T-07 without an HTTP route | Developer inconsistency 5, RV-05 |
| Estimate replaced by ceilings for each P2 option, plus P12 | Developer RK-8, RV-04 |
| T-15 now also depends on P4 | Developer, RV-15 |
| MCP moved after T-19 and reduced to 3 tools | RV-14 |
| New §3 of user inputs | RV-15, RV-17 |
| Risks renamed RK-x | RV-11 |
| Removed the claim that everything was saved verbatim | RV-13 |
