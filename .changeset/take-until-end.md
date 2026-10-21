---
"@thomasfosterau/effect-parse": patch
---

`Token.takeUntil` and `Text.<encoding>.takeUntil` now stop at `State.end`, like the other token parsers, in interpreted and compiled code. A literal only counts as found when it lies wholly within the input up to `end`, so a parser run over a narrowed region no longer matches past it, returns text from outside it, or leaves `pos` past `end` ([#30](https://github.com/thomasfosterau/effect-parse/issues/30)).
