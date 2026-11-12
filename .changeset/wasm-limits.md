---
"@thomasfosterau/effect-parse": patch
---

`Compiler.wasm` stays within its memory and agrees with the interpreter at the limits (#123):

- A parse whose input and trace need more linear memory than the engine will give, or more than 2 GiB, now runs on the JIT (which parses the input in place) instead of throwing `RangeError: WebAssembly.Memory.grow()` out of `Parser.parse`. This holds when the trace runs out part-way through a parse as well.
- After a parse that grew a module's memory past 128 MiB, the module gets a new memory, so one large input no longer holds five to ten times its size for the life of the process (a `WebAssembly.Memory` cannot shrink), nor keeps the last string parsed alive.
- Repetition bounds of 2^32 or more were truncated to their low 32 bits: `repeat(p, { min: 2 ** 32 })` succeeded where the interpreter fails, and `{ max: 2 ** 32 }` matched nothing. A minimum that large can now never be met and a maximum that large is no limit, as in the other backends.
- Trace offsets are read unsigned.
