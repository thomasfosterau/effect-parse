---
"@thomasfosterau/effect-parse": minor
---

Add `Compiler.runner(p, options?)`, a prepared runner for drivers that run one compiled grammar many times on states they own, such as a lexer reading a token per run. It returns a function of the state that returns exactly what `Parser.run(p, state, options)` returns, with the compiled form looked up once (and again only when the input kind, or complete versus partial, changes) instead of on every run.

The JIT's generated entry now checks the state's end and reports a call-stack overflow as the same `TooDeep` failure itself, so every runner calls it directly instead of through a separate guard and a closure. On the drivers benchmark's lexer (240 K tokens, one per run), `Parser.run` takes 13.7 ms instead of 14.5, and `Compiler.runner` 11.0 ms: about 46 ns per token against 60 before (#65).
