---
"@thomasfosterau/effect-parse": patch
---

`Compiler.wasm` scans `Binary`'s fixed-size numbers itself instead of calling out to JavaScript for each one: binary formats parse 3–12× faster with it, level with the JIT.
