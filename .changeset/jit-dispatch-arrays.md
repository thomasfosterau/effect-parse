---
"@thomasfosterau/effect-parse": patch
---

The JIT compiles two more shapes of grammar inline. A `Parser.dispatch` with a record of cases and a selector other than `Token.any` or `Parser.peek(Token.any)` now runs the chosen case inline, through a switch on its index, instead of calling its closure-compiled step. On token arrays, `Token.anyToken`, `Token.oneOf`, `Token.noneOf`, `Token.takeWhile` and `Token.takeTill` call their predicate (or membership test) inline instead of running their interpreted steps, which also recorded a failure on every miss: a grammar over 200 K tokens matched with `Token.oneOf(predicate)` runs about 3 times as fast. Results and errors are unchanged. The `Parser.dispatch` docs and the README now say which ways of writing a grammar compile best.
