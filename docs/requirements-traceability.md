# Requirements traceability: Azumo Workspaces

- **Status:** APPROVED (2026-09-29), results updated 2026-09-30.
- **Scope:** P1 = `azumo.co`, P2 = uploads. Link-only items are N/A.
- **Built by:** the coordinator. Sources:
  - architect seed (`af8ceef86d036f86e`)
  - qa map (`a78afac0e6e2a6e3b`)
  - qa verification matrix (`a04a27ab16fdd7b4e`)
  - reviewer corrections
- **Latest real run (bench MCP, 2026-09-30 17:00):** all passed. Runs `20260930T1659*`/`1700*`:

  | Check | Result |
  |---|---|
  | lint | passed |
  | typecheck | passed |
  | unit | 408/408 |
  | integration | 539/539 |
  | e2e (dev) | 43/43 |
  | e2e-prod (`next build` + `next start`) | 43/43 |
  | build | passed |

- **Result labels:**
  - **Passed (real):** real code, real DB engine (PGlite), with no simulated component.
  - **Passed (simulated auth):** DP8 test sessions or synthetic Google claims.
  - **Passed (simulated Blob):** `@vercel/blob` mocked.
  - **Manual pending:** needs production or a real external service.

| Requirement | Acceptance criteria | Tasks | Main tests | Result |
|---|---|---|---|---|
| R1.1 | AC-36 | T-03a, T-07, T-18p | `unit/auth-config`, `unit/test-auth-guard`, `integration/auth-hardening`, `integration/qa-production-fail-closed`; TC-39 | Passed (real + simulated). Production check TC-39: **manual pending** |
| R1.2 | AC-02, AC-03, AC-04, AC-05 | T-06a | `unit/domain-guard`, `integration/auth-domain-guard`, `integration/auth-hardening`, `integration/session` | AC-05 passed (real). AC-02–04 passed (**simulated** claims only). **Real Google TC-40–42: manual pending** |
| R1.3 | AC-06 | T-02, T-06a | `unit/env`, `unit/no-domain-literal`, `integration/auth-route-fail-closed` | Passed (real) |
| R1.4 | AC-01 | T-06b | `unit/server-actions-wrapped`, `integration/qa-exported-actions`, `e2e/auth-redirect`, `e2e/qa-security` | Passed (real for no or forged cookie; simulated for signed-out sessions) |
| R1.5 | AC-07 | T-06b | `integration/session`, `integration/qa-exported-actions` | Passed (simulated auth). Real sign-out TC-40: manual pending |
| R2.1 | AC-08 | T-08 | `integration/workspaces`, `e2e/workspaces` | Passed (simulated auth) |
| R2.2 (P5) | AC-09 | T-08 | `integration/workspaces` | Passed (simulated auth) |
| R2.3 | AC-10, AC-11, AC-12, AC-37, AC-38 | T-05, T-17a | `integration/isolation`, `integration/authorize`, `integration/qa-exported-actions`, `e2e/qa-security`, `unit/db-import-boundary` | Passed (simulated auth) |
| R2.4 | AC-13 | T-08 | `integration/workspaces`, `e2e/workspaces` | Passed (simulated auth) |
| R3.1 | AC-14 | T-03b | `integration/schema-constraints` | Passed (real) |
| R3.2 | AC-15, AC-37 | T-04, T-05, T-17b | `unit/permissions` (all cells), `integration/authorize`, `integration/server-action-handlers`, `integration/qa-exported-actions` | Passed (real matrix; simulated auth) |
| R3.3 (P6, DP3) | AC-16, AC-17 | T-09 | `integration/members`, `e2e/workspaces` | Passed (simulated auth). Concurrency of DP3 is **unverified** on real Postgres |
| R3.4 | AC-18 | T-08, T-09, T-10, T-17b | `e2e/workspaces`, `e2e/pages`, `e2e/uploads`, `e2e/qa-security` | Passed (simulated auth) |
| R4.1 | AC-19, AC-20 | T-10, T-13 | `integration/pages`, `e2e/pages` | Passed (simulated auth) |
| R4.2 (uploads) | AC-22, AC-23 | T-15 | `integration/uploads`, `unit/attachment-rules` | Passed (**simulated Blob**). Real TC-43: manual pending |
| R4.3 | AC-24, AC-25 | T-13, T-16 | `integration/uploads`, `integration/schema-constraints`, `unit/download-headers`, `e2e/uploads` | AC-25 passed (real). AC-24 passed (simulated Blob). Real TC-43 (plus the ~9 MB check, RV-F-04): manual pending |
| R4.4 | AC-26 | T-16 | `integration/uploads`, `e2e/uploads` | Passed (simulated Blob). Real TC-43: manual pending |
| R5.1 | AC-31 | coordinator | `docs/status.md` "Approval (AC-31)" | Recorded 2026-09-29, before the first task |
| R5.2 | AC-32 | coordinator | `docs/status.md`, `docs/bench/tasks.json` | Recorded (corrected per RV-C-02 and RV-F-11) |
| R6.1 (P4) | AC-33 | T-18, T-19 | TC-38 | **Blocked: P4 and deploy authorization** |
| R6.2 | AC-34 | T-01, T-18p | `unit/repo-hygiene`, bundle grep (qa) | Passed (real) in the repository. Vercel env check: manual pending |
| R6.3 (P9) | AC-35 | T-19 | TC-40–42 | **Blocked: OAuth client, P4, P9, test accounts** |
| PR1 (approved) | AC-27, AC-28 | T-11, T-12 | `integration/pages`, `e2e/pages` | Passed (simulated auth) |
| PR2 (approved) | AC-29, AC-30 | T-11 | `unit/page-content`, `unit/no-raw-html`, `integration/pages`, `e2e/pages` | Passed (simulated auth) |

**Rule:** a simulated result never closes AC-02, AC-03, AC-04, AC-33 or AC-35.
