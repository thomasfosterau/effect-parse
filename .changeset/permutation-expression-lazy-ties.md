---
"@thomasfosterau/effect-parse": patch
---

`Parser.permutation` and `Expression.make`'s operator loop no longer merge the failures of attempts that fail at the same offset until the merged failure is read, as `Parser.alt` already does. A round of a permutation in which some parser matches, or an operator round in which some operator matches, discards its tied failures without merging them, and a nested `alt`'s ties are taken over unmerged. Error results are unchanged.
