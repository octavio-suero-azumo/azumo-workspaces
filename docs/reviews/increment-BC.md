# Review: Increments B (auth) and C (workspaces, members, authorization)

- **Agent:** `reviewer` (real invocation: yes, agentId `ab2adebdeb29d04d6`), 2026-09-30. Read-only.
- **Verdict:** approve with changes.
- **Saved by:** the coordinator, condensed from the agent's output.

## Findings

| ID | Severity | Finding | Fix / disposition |
|---|---|---|---|
| RV-C-01 | Medium | Account linking and Google ID-token sign-in are enabled but not needed. Right now only `validateUserInfo` protects a second Google identity that reuses the same email. No test covers it. `update-user` lets a user set any display name. | **Must fix.** Disable `accountLinking` and `disableIdTokenSignIn`, add `disabledPaths` (`link-social`, `unlink-account`, `update-user`, `get-access-token`, `refresh-token`, `account-info`), and add 3 simulated tests. Sent to developer with increment D. |
| RV-C-02 | Medium | Weak traceability records: placeholder task titles, missing AC links, no status.md entries for B/C, T-06a not labeled "simulated". There is also no record of who approved the per-request hardening. | **Must fix.** The coordinator corrected it (see status.md, 2026-09-30). The hardening was approved by the coordinator in the increment C prompt, as a tightening within R1.2, and is now recorded. |
| RV-C-03 | Low | TOCTOU window between `authorize()` and the write when a role is demoted concurrently. | Deferred and accepted as residual risk for the prototype. DP3 still holds. |
| RV-C-04 | Low | Lock order in the last-Owner guard. The concurrency claim is not tested (PGlite has one connection). | `ORDER BY id` sent with increment D. The concurrency claim stays **unverified** until a real Postgres is available (P4). |
| RV-C-05 | Low | Exported server actions are not tested with forged input. | Sent with increment D: move handlers into plain modules and test forged `FormData`. |
| RV-C-06 | Low | The static test-auth import check misses `import()` and `require()`. | Sent with increment D. |
| RV-C-07 | Low | `BETTER_AUTH_URL` is optional in production. | Sent with increment D: require it when `VERCEL_ENV=production`. |
| RV-C-08 | Low (decision) | An Owner may remove themself if another Owner remains, which is effectively "leave workspace". | Server behavior kept (R3.3 bounded by DP3); no "Leave" button. **User to confirm.** |

## Items reviewed with no issues

- The domain check at every layer.
- `action()` and `authorize()` coverage, with the workspace always resolved from the resource.
- DP2 (404 vs 403).
- Role changes taking effect immediately.
- Test assertions: error class, no data leaks, unchanged snapshots.
- No secrets or domain literals in `src/`.
- Plausible bench evidence.
