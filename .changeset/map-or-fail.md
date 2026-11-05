---
"@thomasfosterau/effect-parse": minor
---

Add `Parser.mapOrFail(p, f, orFailWith?)`, the allocation-free form of `tryMap` and `filterMap`: `f` returns `Input.Fail` to reject a value, and compiled code compares the result with the sentinel instead of allocating and unwrapping a `Result` or `Option` on every success. `orFailWith` builds the user error (the `ParseError`'s `cause`) only on failure; without it, the failure has no cause, as with `filterMap`. Where V8 does not inline the callback and remove the wrapper (a large grammar that exhausts its inlining budget), a check on every token runs about 1.3× faster than with `tryMap` (#66).
