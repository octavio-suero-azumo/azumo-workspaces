# Review: Increments D, E, F and pre-deploy readiness (T-20, partial)

- **Agent:** `reviewer` (real invocation: yes, agentId `ae21895315f4e5a6a`), 2026-09-30. Read-only.
- **Verdict:** approve with changes.
- **Summary:** code, authorization and the RV-C-01 fix are verified sound. Deploy readiness is not: the production migration path, and real Postgres/Neon, Blob and SSO, have never been exercised.
- **Saved by:** the coordinator, condensed from the agent's output.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| RV-F-01 | Blocker (deploy) | No documented production migration path. `db:migrate` silently falls back to PGlite. | Guarded `db:migrate:prod` script + runbook (sent to developer). |
| RV-F-02 | High | No code has run against real Postgres/Neon. | **Blocked on P4**: smoke test on a Neon dev branch before production. |
| RV-F-03 | Medium | postgres-js pool defaults are unsuitable for Vercel Functions. | `max: 3, idle_timeout, connect_timeout` (sent to developer). |
| RV-F-04 | Medium | 10 MB downloads stream through a Function with a documented 4.5 MB limit; unclear if streaming is exempt. | Verify with a ~9 MB file in TC-43. Lowering P8 needs user approval. |
| RV-F-05 | Medium | E2E only ever ran against `next dev`. | Run E2E once against `next build && next start` (sent to developer). |
| RV-F-06 | Low | PGlite is refused only when `VERCEL_ENV=production`; imported statically. | Refuse whenever `VERCEL` is set; use a dynamic import (sent to developer). |
| RV-F-07 | Low | `BETTER_AUTH_URL` accepts `http:` in production. | Require https in production (sent to developer). |
| RV-F-08 | Low | Comment overstates the content-type check (the type is client-declared). | Reword the comment (sent to developer). |
| RV-F-09 | Low | Orphan blobs are possible. | Accepted residual risk (RK-5). |
| RV-F-10 | Low | bench-mcp: an all-skipped suite counts as `passed`; redaction too broad. | Require `testsPassed > 0` (sent to developer). The rest is deferred. |
| RV-F-11 | Low | PRD §0 wording is stale; the T-16 AC list is not labeled simulated; C tasks are linked to D runs. | Fixed by the coordinator. |
| RV-F-12 | Low (decisions) | P4, P9, P10, deploy authorization, RV-C-08 and the test accounts are still open. | Put to the user. |

**Confirmed with no issues:**
- Page authorization and strict content validation (no raw HTML sinks).
- Upload order: session → authorize → prefix → size/type, all before any token is signed.
- The download route's headers, and no blob URL reaches the client.
- Repository hygiene.
- bench-mcp: root confinement, fixed commands, process-group timeouts, `no_tests` never counted as passed, no secrets in the sampled reports.
