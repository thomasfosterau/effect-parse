---
"@thomasfosterau/effect-parse": minor
---

`Token.takeUntilAny(literals)`: takes input up to the first occurrence of any of several literals, the search a multi-pattern prefilter makes. On byte input `Compiler.wasm` now compiles it, and `Token.takeUntil`, natively with WebAssembly SIMD: Teddy (as in ripgrep), which tests the first three bytes of every literal at sixteen positions at once with nibble-table lookups and checks each candidate in full. Elsewhere successive searches over one input remember where each literal next occurs, so each is searched for once per occurrence. Results are unchanged.

When each of the first three positions holds at most three distinct bytes across the literals (one literal, or the case variants of a few), the search compares with `i8x16.eq` instead of nibble tables, and a candidate is checked with the widest loads its literals fill.
