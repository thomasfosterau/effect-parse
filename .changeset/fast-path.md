---
"@thomasfosterau/effect-parse": minor
---

Add `Parser.withFastPath(grammar, fast)`, a supported way to put a hand-written scanner in front of a grammar. Compiled code calls `fast(state)` first; it returns the grammar's value with `state.pos` where the grammar would stop, or `Parser.Defer` to run the grammar from the same offset. Interpreted runs use the grammar alone, so every error, `Syntax` tree and trace is exactly the grammar's. `Parser.verifyFastPath(grammar, fast, inputs)` runs both at every offset of every input, complete and partial, and returns the places where they disagree (#78).
