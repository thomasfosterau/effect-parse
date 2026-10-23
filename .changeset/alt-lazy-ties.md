---
"@thomasfosterau/effect-parse": patch
---

Interpreted `Parser.alt` no longer merges the failures of branches that fail at the same offset until the merged failure is read. A nested `alt` hands its tied failures to the enclosing one unmerged, so an `alt` whose next branch consumes input never pays for the merge: about 30% faster on a token-heavy interpreted grammar. Error results are unchanged. `Input.State`'s `failure` and `deepest` are now accessors (reads and writes behave as before).
