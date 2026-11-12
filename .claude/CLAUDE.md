# CLAUDE.md

Claude Code loads this file. It holds only what is specific to Claude Code; the project's conventions, gates and API guide are the files imported here.

@../AGENTS.md @../CONTRIBUTING.md @../README.md

## Claude Code sessions

- The SessionStart hook (`.claude/hooks/session-start.sh`) installs the global Vite+ CLI at the catalog's `vite-plus` pin with the official installer (npm-provenance and SHA-512 checked; it needs `vite.plus` and `viteplus.dev` on the environment's network allowlist), links `vp` and `vpx` into `~/.local/bin` (the CLI lives under `$VP_HOME` when set, as in the Vite+ container image, else `~/.local/share/vite-plus`), and runs `vp install --frozen-lockfile`. The global `vp` delegates to each checkout's own `vite-plus` (worktrees included), and everything else goes through it: `vp exec fallow …` for fallow, `vpx <file>.ts` for a TypeScript script. Nothing else is put on PATH. If the installer can't run, `vp` falls back to this checkout's `node_modules` copy. It hydrates no secrets; none are needed, and nothing here can publish.
- A PreToolUse hook (`.claude/hooks/fallow-gate.sh`) blocks `git commit` / `git push` when `fallow audit --base origin/trunk` (run as `vp exec fallow`) fails; it audits only this checkout and its `.claude/worktrees/*`, skipping any other tree with a notice, and regenerates the coverage map (`vp run test:coverage`, cached when nothing changed) when it is missing or older than `src/`, `test/` or the test config, blocking the commit if that run fails. A PostToolUse hook runs `vp fmt` on every source, JSON, CSS or Markdown file you write or edit.
