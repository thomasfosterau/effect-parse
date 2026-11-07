---
"@thomasfosterau/effect-parse": patch
---

`seq` builds its tuples with an array literal per arity (up to 8) in the interpreter and the closure compiler, as the JIT already did, so V8 can allocate tuples that a parse keeps straight into the old generation instead of copying them through scavenges.
