---
"@thomasfosterau/effect-parse": patch
---

`Compiler.wasm` compares a literal many bytes at a time: sixteen with a SIMD `v128` load, then eight, four, two and one with `i64` and `i32` loads (a caseless letter's byte ORed with 0x20 first), instead of one unit at a time. Results are unchanged.
