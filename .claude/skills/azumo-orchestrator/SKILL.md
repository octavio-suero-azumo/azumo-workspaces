---
name: azumo-orchestrator
description: This skill should be used when the user asks to "coordinate the agents", "start the research phase", "run the planning phase", "create the PRD", "implement task T-x", "test this task", "review the work", or otherwise advance Azumo Workspaces through research, planning, implementation, testing, or review using the project subagents (researcher, architect, developer, qa, reviewer).
---

# Azumo Workspaces Orchestrator

Coordinate the specialist subagents defined in `.claude/agents/` from the main conversation. Communicate with the user in Spanish; write agent prompts and code in English.

## 1. Before acting

1. Read `CLAUDE.md`, `docs/brief.md`, `docs/agent-workflow.md`, and `docs/status.md` (create it on first run, see section 6).
2. Read any existing planning documents under `docs/`.
3. Identify the phase the user has authorized in the current request. If none is clearly authorized, ask; do not assume.

## 2. Phases

Keep phases separate. Never start a later phase without explicit user authorization.

| Phase | Agents | Writes files? | Outputs |
|-------|--------|---------------|---------|
| Research | researcher | Coordinator only | `docs/research/<topic>.md` |
| Planning | architect (+ researcher, qa for test plan) | Coordinator only, after user review | `docs/PRD.md`, `docs/architecture.md`, `docs/implementation-plan.md`, `docs/test-plan.md`, `docs/requirements-traceability.md` |
| Implementation | developer | developer | Code for one approved task |
| Testing | qa | qa (test files only) | Tests and real run results |
| Review | reviewer | Coordinator only | `docs/reviews/<task-id>.md` |

Implementation requires: an approved `docs/PRD.md`, an approved `docs/implementation-plan.md`, resolved open decisions that the task depends on, and explicit user approval to implement that task.

## 3. Invoking specialists

- Invoke subagents for real with the Agent tool (`subagent_type`: `researcher`, `architect`, `developer`, `qa`, `reviewer`). Never write or paraphrase an answer as if an agent produced it without invoking it.
- If an agent cannot be invoked (not loaded, tool error), report the exact error to the user and stop that step. Do not substitute a simulated answer.
- Give each agent a self-contained prompt with:
  - **Context:** phase, task ID, relevant requirement IDs, open decisions that affect it.
  - **Files to read:** explicit paths.
  - **Expected result:** the output format from the agent definition, plus any specific sections needed.
  - **Constraints:** what is out of scope; no dependency installs, commits, pushes, or deploys unless authorized.
- Run agents that edit files one at a time. Never run developer and qa (or two developers) concurrently on the same tree. Read-only agents may run in parallel.

## 4. Saving deliverables

- researcher, architect, and reviewer cannot write files. Save their returned output verbatim or lightly formatted to the paths in section 2, with a header noting agent name, date, and the prompt summary.
- Planning documents are drafts until the user approves them. Mark each with `Status: Draft` or `Status: Approved (date)`.
- The traceability document maps every requirement ID (R*, and PR* once approved) to tasks and tests.

## 5. Task loop (implementation, testing, review)

For each approved task, in order:

1. developer implements the task and reports files changed and checks run.
2. qa verifies with real runs (and writes tests if the testing phase is authorized).
3. reviewer reviews code, permissions, and evidence.
4. If qa or reviewer finds defects, send them back to developer. Count correction cycles.
5. **Stop after two unsuccessful correction cycles** and report to the user with the evidence and the blocker.

A task is done only when: acceptance criteria are verified by real evidence, qa results are labeled real (not only mocked) for what they claim, the reviewer verdict is not `reject`, and the traceability document is updated. Existing code alone is not completion.

## 6. Status log

Maintain `docs/status.md` with one entry per step:

```
## <date> — <phase> — <task ID or topic>
- Agent invoked: <name> (real invocation: yes/no)
- Input summary: ...
- Result: ...
- Evidence: <paths, command outputs>
- Blockers: ...
- Next step / approval needed: ...
```

Record blockers and failed invocations as well as successes.

## 7. Rules that always apply

- Keep mandatory requirements, proposals, and open decisions separate. Do not resolve open decisions (for example the SSO domain `azumo.com` vs `azumo.co`) without explicit user confirmation.
- No commits, pushes, deployments, dependency installs, or external resource creation without specific authorization.
- No secrets in the repository; no production data.
- Never claim a test ran, a check passed, or an agent was invoked without evidence.
- The MCP server for this project is not yet implemented; do not reference its tools as available.
