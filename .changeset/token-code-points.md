---
"@thomasfosterau/effect-parse": minor
---

Add `Token.codePoints(name, predicate, ranges?)`, which declares a character class as a predicate over code points. In token sets on string, `Text` and byte input it receives each character as a number, so testing a character allocates nothing, and with `ranges` compiled parsers test the ranges instead of calling it. Plain `(c: string) => boolean` predicates still receive whole characters, now built with `String.fromCharCode` below U+10000 instead of `String.fromCodePoint`. The README says which token sets are the fast path. Closes #22.
