---
"@thomasfosterau/effect-parse": minor
---

`Token.takeUntilAny(literals)`: takes input up to the first occurrence of any of several literals, the search a multi-pattern prefilter makes. On byte input `Compiler.wasm` now compiles it, and `Token.takeUntil`, natively with WebAssembly SIMD: Teddy (as in ripgrep), which tests the first three bytes of every literal at sixteen positions at once with nibble-table lookups and checks each candidate in full. Elsewhere successive searches over one input remember where each literal next occurs, so each is searched for once per occurrence. Results are unchanged.
