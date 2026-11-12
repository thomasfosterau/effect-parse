---
"@thomasfosterau/effect-parse": patch
---

`Compiler.jit` and `Compiler.wasm` generate code in proportion to the grammar (#122). A parser used twice by the same parent (`Parser.seq(p, p)`) counted as used once, so it was inlined at both places, and a grammar that did so at every level doubled its generated code per level: twenty lines compiled to 160 MB of JavaScript in 22 s, and ran the WebAssembly compiler out of memory. Uses are now counted, so such a parser becomes one rule that both places call. A grammar that is itself enormous (over 100 000 parsers to inline for one root, which no sharing can reduce) is no longer turned into source text at all: the closure compiler takes over, and `Compiler.fallbacks` / the registry record why.
