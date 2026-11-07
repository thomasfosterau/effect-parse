---
"@thomasfosterau/effect-parse": patch
---

Interpreted steps called from compiled code, such as a `Parser.make` guard, no longer allocate a `Failure` each time they backtrack or cut: a compiled run throws its failures away and the interpreter builds the error, so `State.backtrack` and `State.cut` record only the mode there.
