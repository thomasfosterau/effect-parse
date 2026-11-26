# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first; this file only adds what is specific to agents.

- You may open pull requests in this repository (GitHub MCP tools or `gh`). Follow `.github/pull_request_template.md` and say which gates ran and which couldn't.
- Out-of-scope work you notice: file an issue and move on.
- Write idiomatic Effect v4 (see docs/CONTRIBUTING.md); non-idiomatic code that isn't a trivial fix gets an issue listing the sites and the replacement.
- Other libraries depend on the exported surface: change it only on purpose, with a changeset.
- `docs/ARCHITECTURE.md` gives the broad view of the compilers, streaming and syntax trees, and each internal module's header comment the details; read both before changing one.
- The full suite takes about 90 s; run single files while iterating.
- Publish only through the Release workflow; there is no publish script. Release-path registry calls go through `vp pm` (`pack`, `publish`, `view`), never `npm` / `pnpm` directly.

## Pull requests

- **Write the PR body with the `pr` skill** from Matt Pocock's skills (`mattpocock-skills:pr`), filling in the repository's pull request template where there is one.
- **Resolve merge conflicts before you hand a PR over.** Rebase onto `origin/trunk` and push; a PR that conflicts with `trunk` isn't finished.
- **Mark the PR ready for review as soon as the initial draft is finished.** Don't wait for CI to run, for reviews, or for the owner to do it. Keep fixing CI failures and review findings on the ready PR.

## Fallow

- `vp install` links the `fallow` skill into `.claude/skills/fallow` from the installed package (approved under `permissions` in `pnpm-workspace.yaml`). The pre-commit `fallow:audit` gate and the rest of the repository's rules are in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).
