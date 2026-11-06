---
"@thomasfosterau/effect-parse": patch
---

`Compiler.wasm` vectorises `takeWhile` and `takeTill` on bytes (`Token` and Latin-1 text) with WebAssembly SIMD: sixteen bytes per step, then thirty-two once a run is that long, tested against at most three stop bytes with `i8x16.eq` or against nibble tables with `i8x16.swizzle`; the first byte that does not belong ends the run without a scalar step. A run of 8.5 MB scans about 3.7× as fast (1.6 GB/s to 5.8 GB/s with the copy into WebAssembly memory). Results are unchanged.
