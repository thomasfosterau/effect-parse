---
"@thomasfosterau/effect-parse": patch
---

`Input.State.reset` keeps what the state has learnt about its input: where the stop characters of compiled `Token.takeTill` searches occur (#126). The positions are absolute and a state's input never changes, so they hold wherever the next run starts. Before, a lexer that reset one state before each token searched for a stop character that was rare or absent (`&` in ordinary XML text) to the end of the buffer again for every token, which made lexing a whole string quadratic (4 MB took about 4 s through effect-xml).
