# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first; this file only adds what is specific to agents.

- You may open pull requests in this repository (GitHub MCP tools or `gh`). Follow `.github/pull_request_template.md` and say which gates ran and which couldn't.
- Out-of-scope work you notice: file an issue and move on.
- Write idiomatic Effect v4 (see docs/CONTRIBUTING.md); non-idiomatic code that isn't a trivial fix gets an issue listing the sites and the replacement.
- Other libraries depend on the exported surface: change it only on purpose, with a changeset.
- `docs/DESIGN.md` explains the compilers, streaming and syntax trees; read the relevant section before changing one.
- The full suite takes about 90 s; run single files while iterating.

## Fallow

Before a commit or push, run `vp run test:coverage`, then `vp exec fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk`. Fix a `fail` verdict caused by your change; treat `{ "error": true }` as non-blocking. Pre-existing complexity and duplication are recorded in `fallow-baselines/`; re-save a baseline only to shrink it.
