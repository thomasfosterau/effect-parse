## Summary

What changed and why. If this closes an issue, add `Closes #N` so it closes on merge to `trunk`.

## Verification

Run the gates in [AGENTS.md](https://github.com/thomasfosterau/effect-parse/blob/trunk/AGENTS.md#verification) and list each command with its final pass/fail. If a gate could not run, say which and why. For a change to a parser hot path or a compiler, give `vp run bench` (and the benchmark for the area) before and after.

## Changeset

Name the changeset(s) under `.changeset/`, or say why none is needed (see [AGENTS.md](https://github.com/thomasfosterau/effect-parse/blob/trunk/AGENTS.md#branches-and-pull-requests)).

## Notes

Anything reviewers should look at closely: exported signatures (other libraries depend on them), the peer range, `/*#__PURE__*/` on top-level calls (`sideEffects: false`), compiled/interpreted agreement.
