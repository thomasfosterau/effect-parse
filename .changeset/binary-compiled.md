---
"@thomasfosterau/effect-parse": patch
---

`Binary`'s fixed-size numbers compile: the JIT reads them inline on byte input instead of calling their step, about 3× faster for a sequence of mixed numbers and level with a hand-written `DataView` loop for a run of one kind.
