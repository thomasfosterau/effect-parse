---
"@thomasfosterau/effect-parse": minor
---

Add `Compiler.wasm`, a third parser compiler. It scans the input in WebAssembly, with code generated from the grammar, and builds the value with a generated JavaScript function that reads what the scan recorded, so results and errors are those of the interpreter, as with the other compilers. On the JSON benchmarks it parses strings, UTF-8 and UTF-16 bytes faster than `Compiler.jit`. It copies input into WebAssembly memory with standard `ArrayBuffer` views and `TextEncoder`, so it runs the same everywhere. Array input, streaming builds, and environments without `WebAssembly` or `new Function` use the JIT.
