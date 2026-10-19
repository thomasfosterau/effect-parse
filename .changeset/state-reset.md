---
"@thomasfosterau/effect-parse": minor
---

Add `Input.State.reset(offset, options?)`, which prepares a state for another run over the same input, so that drivers making many small runs over one buffer (one per token, say) don't allocate a new `State` each time. It resets every per-run field, so callers no longer need to know which ones those are. After a reset the state behaves exactly like `new State(state.input, { ...options, offset })`, including after a run that failed or returned `Incomplete` ([#20](https://github.com/thomasfosterau/effect-parse/issues/20)).
