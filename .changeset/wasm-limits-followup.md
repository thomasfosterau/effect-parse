---
"@thomasfosterau/effect-parse": patch
---

`Compiler.wasm`: where a parse's trace starts is computed without 32-bit arithmetic, so an input near 2^31 bytes is recognised as too large for the module's memory and handed to the JIT instead of wrapping to a negative offset; and a parse handed over part-way through leaves the caller's `State` (cursor, mode and hint) as it was before the WebAssembly attempt, so the JIT's run is the only one it shows.
