---
"@thomasfosterau/effect-parse": patch
---

The parsers inside `Expression.make`, `Parser.permutation` and `Binary.lengthTake` now compile with the grammar around them instead of running interpreted: compiled expression grammars run about twice as fast.
