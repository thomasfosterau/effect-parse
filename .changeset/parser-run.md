---
"@thomasfosterau/effect-parse": minor
---

Add `Parser.run(parser, state)`, which runs a parser on an `Input.State` you own and returns its output or `Fail`, like `parser.step(state)` but using the parser's compiled form when it has one. A lexer that keeps one state and `reset`s it before each token now runs its token parser compiled without allocating a state, a `Result` or a slice per token: about 1.9 times as fast as calling `step` on a reused state, and 15% faster than `parsePartial` with an `offset`. On failure the parser runs again interpreted from the same position, so the state holds the interpreter's failure; partial states run the build that handles partial input.

`ParserStream.parseMany` now runs a compiled parser compiled, with one state per buffer, instead of always interpreting it: about 2.8 times as fast on a stream of CSV-like rows.
