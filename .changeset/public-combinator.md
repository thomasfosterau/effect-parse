---
"@thomasfosterau/effect-parse": minor
---

Add `Parser.combinator(parsers, build, name?)`, for writing combinators whose inner parsers compile. `build` makes the combinator's step from the parsers' steps, which `Parser.Steps<Ps>` types. Interpreted, it receives their own steps; compiled, their compiled steps. A combinator written with `Parser.make` is opaque to the compilers, so it and every parser it runs stay interpreted (#83).
