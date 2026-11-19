# Claude Code

Read the README, docs/CONTRIBUTING.md and AGENTS.md (imported below). This file covers only Claude Code specifics.

- A PostToolUse hook runs `vp fmt` on files you edit. The fallow audit is a git pre-commit hook (docs/CONTRIBUTING.md), not a Claude hook.
- Use worktrees under `.claude/worktrees/`, one per branch; each needs its own `vp install`.

@../README.md

@../docs/CONTRIBUTING.md

@../AGENTS.md
