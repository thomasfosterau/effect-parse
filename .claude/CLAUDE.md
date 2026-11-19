# Claude Code

Read the README, docs/CONTRIBUTING.md and AGENTS.md (imported below). This file covers only Claude Code specifics.

- A PreToolUse hook in `.claude/settings.json` runs `fallow audit --base origin/trunk` before `git commit` / `git push` and blocks on a `fail` verdict. It reads the coverage map on disk, so run `vp run test:coverage` first. A PostToolUse hook runs `vp fmt` on files you edit.
- Use worktrees under `.claude/worktrees/`, one per branch; each needs its own `vp install`.

@../README.md

@../docs/CONTRIBUTING.md

@../AGENTS.md
