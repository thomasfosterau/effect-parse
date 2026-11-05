---
"@thomasfosterau/effect-parse": minor
---

Add `Parser.mapSpan(p, (a, start, end) => b)` and `Parser.seqWith(parsers, (a, b, ...) => c)`, the allocation-free spellings of `map(withSpan(p), ...)` and `map(seq(...), ...)`: compiled code passes the offsets, or one value per parser, straight to the callback instead of building a tuple and a span object on every success. V8 often removes those allocations itself when it inlines the callback; in a large grammar that exhausts its inlining budget, a lexer that records spans runs about 10% faster with `mapSpan` (#64).
