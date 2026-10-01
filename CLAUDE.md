# Azumo Workspaces — Project Rules

1. Read `docs/brief.md` before taking any action. Read `docs/agent-workflow.md` before coordinating agents.
2. Write explanations to the user in Spanish. Write code, comments, and internal agent instructions in English.
3. Do not implement features without an approved PRD (`docs/PRD.md`) and an approved implementation plan.
4. Do not commit, push, or deploy without specific authorization for that action.
5. Do not store secrets (keys, tokens, OAuth client secrets) in the repository. Do not use production data.
6. Do not claim that tests ran, checks passed, or agents were invoked without real evidence (command output, tool results, agent transcripts).
7. Keep mandatory requirements, proposals pending validation, and open decisions clearly separated. Do not promote a proposal or resolve an open decision without explicit user confirmation.
8. The final product is the application. Subagents, skills, and the MCP server are tools to build it, not deliverables in themselves.
9. Use the `azumo-orchestrator` skill to coordinate the specialist subagents in `.claude/agents/`.
10. Preserve `LOCAL_ACCESS_CHECK.md`.
