---
"@thomasfosterau/effect-parse": minor
---

Add a `while` option to `Parser.fold`, a predicate on the accumulator that stops the repetition, successfully and without consuming more input, once it is false. It is checked before each element once `range.min` elements are folded, and compiles to a loop-condition check, so a fold can stop at "N kept items" instead of scanning the rest of the input ([#16](https://github.com/thomasfosterau/effect-parse/issues/16)).
