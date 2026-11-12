---
"@thomasfosterau/effect-parse": patch
---

`Input.State.reset` keeps, for string input, what the state has learnt about its input: where the stop characters of compiled `Token.takeTill` searches and the literals of `Token.takeUntilAny` occur (#126). The positions are absolute and a string never changes, so they hold wherever the next run starts. Before, a lexer that reset one state before each token searched for a stop character that was rare or absent (`&` in ordinary XML text) to the end of the buffer again for every token, which made lexing a whole string quadratic (4 MB took about 4 s through effect-xml).

For byte and array input `reset` still drops what was remembered, because a caller may refill such a buffer in place between runs (a `Uint8Array` source is viewed, not copied): reuse a `State` over a buffer you overwrite and every run searches afresh, as before.

Also fixed: a `takeUntilAny` search that found nothing while a parser had narrowed the input's end was remembered as "not found" after the end widened again, so a literal further on could be missed within the same run. A miss is now remembered together with the end it was searched to.
